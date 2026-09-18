import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { access, chmod, copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { MachineSettings, PortableProfile } from '../../shared/automation'
import type { EngineStatus, LoopsEngineAPI } from '../../shared/workbench'
import { runCapture } from '../exec'
import { materializeSessionRuntime } from './ide-profile'

type PortableEngine = NonNullable<NonNullable<PortableProfile['workbench']>['engine']>
type PortableLoop = PortableEngine['loops'][string]

interface HostState {
  version: 1
  token: string
  port: number
  dashboardPid?: number
  dashboardRef?: string
  dispatcherPid?: number
}

interface AssetManifest {
  version: 1
  source: string
  digest: string
  files: string[]
  installedAt: string
}

const MUTABLE_TOP_LEVEL: Record<string, true> = { loops: true, products: true, state: true, 'loops.env': true, '.agent': true }
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const record = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 설정이 올바르지 않습니다.`)
  return clone(value as Record<string, unknown>)
}
function stable(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort)
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]))
    return item
  }
  return JSON.stringify(sort(value))
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true } catch { return false }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error('Loops 포트를 확보하지 못했습니다.') }
  const port = address.port
  server.close()
  await once(server, 'close')
  return port
}

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) throw new Error(`${label} id가 안전하지 않습니다: ${value}`)
}

function assertPortableValue(value: unknown, label: string): void {
  if (typeof value === 'string') {
    if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('~/') || /(^|[\s=\"'(])\/(?:Users|home|private|tmp|Volumes|opt|var|etc)\//.test(value)) throw new Error(`${label}에 머신 절대경로가 포함되어 있습니다.`)
    return
  }
  if (Array.isArray(value)) { value.forEach((entry, index) => assertPortableValue(entry, `${label}[${index}]`)); return }
  if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) assertPortableValue(entry, `${label}.${key}`)
}

export class LoopsEngineHost implements LoopsEngineAPI {
  readonly runtime: string
  private readonly hostStatePath: string
  private readonly deferredPath: string
  private state?: HostState
  private preparing?: Promise<void>
  private starting?: Promise<EngineStatus>
  private assetsPrepared = false
  private preparedSignature?: string

  constructor(private readonly options: {
    root: string
    source: string
    getSettings(): MachineSettings
    getOmp(): PortableProfile['omp']
  }) {
    this.runtime = join(options.root, 'loops-engine')
    this.hostStatePath = join(this.runtime, 'state', 'palace-host.json')
    this.deferredPath = join(this.runtime, 'state', 'deferred-portable.json')
  }

  private async walkSource(directory: string, prefix = ''): Promise<string[]> {
    const result: string[] = []
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!prefix && Object.hasOwn(MUTABLE_TOP_LEVEL, entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) result.push(...await this.walkSource(join(directory, entry.name), rel))
      else result.push(rel)
    }
    return result.sort()
  }

  private async syncAssets(): Promise<void> {
    const files = await this.walkSource(this.options.source)
    const prior = await readJson<AssetManifest>(join(this.runtime, 'state', '.palace-assets.json'))
    const current = new Set(files)
    for (const old of prior?.files ?? []) {
      if (current.has(old) || old.split('/').some((part, index) => index === 0 && Object.hasOwn(MUTABLE_TOP_LEVEL, part))) continue
      await rm(join(this.runtime, old), { force: true })
    }
    const hash = createHash('sha256')
    for (const rel of files) {
      const source = join(this.options.source, rel)
      const destination = join(this.runtime, rel)
      const info = await lstat(source)
      await mkdir(dirname(destination), { recursive: true })
      if (info.isSymbolicLink()) {
        await rm(destination, { recursive: true, force: true })
        await symlink(await readlink(source), destination)
      } else {
        await copyFile(source, destination)
        await chmod(destination, info.mode & 0o777)
      }
      hash.update(rel).update('\0').update(await readFile(source)).update('\0')
    }
    const manifest: AssetManifest = { version: 1, source: this.options.source, digest: hash.digest('hex'), files, installedAt: new Date().toISOString() }
    await writeFile(join(this.runtime, 'state', '.palace-assets.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  }

  private async loadHostState(): Promise<HostState> {
    if (this.state) return this.state
    const stored = await readJson<HostState>(this.hostStatePath)
    this.state = stored?.version === 1 && typeof stored.token === 'string' && stored.token.length >= 32 && Number.isInteger(stored.port) && stored.port > 0 && stored.port < 65536
      ? stored
      : { version: 1, token: randomBytes(32).toString('hex'), port: 8422 }
    return this.state
  }

  private async saveHostState(): Promise<void> {
    if (!this.state) return
    await writeFile(this.hostStatePath, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 })
  }

  private async prepare(): Promise<void> {
    const settings = this.options.getSettings()
    const omp = this.options.getOmp()
    const signature = stable({ settings, omp })
    if (this.preparedSignature === signature) return
    if (this.preparing) {
      await this.preparing
      if (this.preparedSignature !== signature) await this.prepare()
      return
    }
    this.preparing = (async () => {
      await access(this.options.source, constants.R_OK)
      await mkdir(this.runtime, { recursive: true })
      await Promise.all(['loops', 'products', 'state', 'worktrees', '.agent/skills'].map((path) => mkdir(join(this.runtime, path), { recursive: true })))
      if (!this.assetsPrepared) {
        await this.syncAssets()
        const bundledSkill = join(this.runtime, 'skills', 'create-loop')
        if (await fileExists(bundledSkill)) {
          await rm(join(this.runtime, '.agent', 'skills', 'create-loop'), { recursive: true, force: true })
          await cp(bundledSkill, join(this.runtime, '.agent', 'skills', 'create-loop'), { recursive: true })
        }
        this.assetsPrepared = true
      }
      const host = await this.loadHostState()
      const command = settings.ompCommand.trim() || 'omp'
      const ompRuntime = await materializeSessionRuntime({ runtimeRoot: join(this.runtime, 'state', 'omp'), sessionId: 'loops', workspaceCwd: this.runtime, omp })
      const projects = Object.entries(settings.projectPaths).map(([id, path]) => ({ id, path }))
      const profileEnv = [
        `export LOOPS_PORT=${shellQuote(String(host.port))}`, `export PALACE_LOOPS_PORT=${shellQuote(String(host.port))}`,
        `export LOOPS_HOST_TOKEN=${shellQuote(host.token)}`, `export PALACE_WORKTREE_BASE=${shellQuote(join(this.runtime, 'worktrees'))}`,
        `export OMP_COMMAND=${shellQuote(command)}`, `export LOOPS_OMP_CONFIG=${shellQuote(ompRuntime.configPath)}`,
        `export WORKTREE_BASE=${shellQuote(join(this.runtime, 'worktrees'))}`
      ]
      if (projects[0]) profileEnv.push(`export DEFAULT_REPO=${shellQuote(projects[0].path)}`)
      if (ompRuntime.instructionsPath) profileEnv.push(`export LOOPS_OMP_INSTRUCTIONS=${shellQuote(ompRuntime.instructionsPath)}`)
      await writeFile(join(this.runtime, 'state', 'palace-env.sh'), `${profileEnv.join('\n')}\n`, { mode: 0o600 })
      await writeFile(join(this.runtime, 'state', 'palace-projects.json'), JSON.stringify(projects, null, 2) + '\n', { mode: 0o600 })
      await this.saveHostState()
      this.preparedSignature = signature
    })().finally(() => { this.preparing = undefined })
    await this.preparing
  }

  private async prerequisites(): Promise<Array<{ name: string; available: boolean; message?: string }>> {
    const checks = [
      ['OMP', `${this.options.getSettings().ompCommand.trim() || 'omp'} --version`],
      ['Node.js', 'node --version'], ['Git', 'git --version'], ['GitHub CLI', 'gh --version'],
      ['cmux', 'command -v cmux || test -x /Applications/cmux.app/Contents/Resources/bin/cmux']
    ] as const
    const result: Array<{ name: string; available: boolean; message?: string }> = await Promise.all(checks.map(async ([name, command]) => {
      const check = await runCapture(command, this.runtime, undefined, 8_000)
      return { name, available: check.code === 0, message: check.code === 0 ? check.stdout.trim().split('\n')[0] : '설치가 필요합니다' }
    }))
    const gh = await runCapture('env -u GITHUB_TOKEN -u GH_TOKEN gh auth status', this.runtime, undefined, 8_000)
    result.push({ name: 'GitHub 로그인', available: gh.code === 0, message: gh.code === 0 ? '연결됨' : 'Palace 환경 설정에서 GitHub 로그인을 완료하세요.' })
    const cmux = await runCapture('cmux list-workspaces', this.runtime, undefined, 8_000)
    result.push({ name: 'cmux 실행', available: cmux.code === 0, message: cmux.code === 0 ? '실행 중' : 'cmux 앱을 실행하세요.' })
    const loopsEnv = await readFile(join(this.runtime, 'loops.env'), 'utf8').catch(() => '')
    const linearConfigured = !!process.env.LINEAR_API_KEY || /^\s*LINEAR_API_KEY\s*=\s*[\"']?[^\"'\s#]+/m.test(loopsEnv)
    result.push({ name: 'Linear API', available: linearConfigured, message: linearConfigured ? '설정됨' : '대시보드의 워크스페이스 설정에서 Linear API 키를 연결하세요.' })
    const deferred = await readJson<PortableEngine>(this.deferredPath)
    const aliases = new Set<string>()
    const collect = (config: Record<string, unknown>): void => {
      const repo = config.repo
      if (typeof repo === 'string' && repo.startsWith('project:')) aliases.add(repo.slice('project:'.length))
    }
    Object.values(deferred?.products ?? {}).forEach(collect)
    Object.values(deferred?.loops ?? {}).forEach((loop) => collect(loop.config))
    for (const alias of aliases) result.push({ name: `프로젝트 ${alias}`, available: false, message: `이 컴퓨터에서 '${alias}' 프로젝트 폴더를 선택하면 루프 정의가 적용됩니다.` })
    return result
  }

  private async dashboardHealth(): Promise<{ ok: boolean; pid?: number }> {
    const state = await this.loadHostState()
    try {
      const response = await fetch(`http://127.0.0.1:${state.port}/api/health`, { headers: { 'x-palace-engine-proxy': '1', authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(1500) })
      if (!response.ok) return { ok: false }
      const body = await response.json() as { ok?: boolean; pid?: number }
      return { ok: body.ok === true, pid: body.pid }
    } catch { return { ok: false } }
  }

  async status(): Promise<EngineStatus> {
    try {
      await this.prepare()
      const prerequisites = await this.prerequisites()
      const health = await this.dashboardHealth()
      const missing = prerequisites.filter((item) => !item.available)
      return {
        available: prerequisites.slice(0, 7).every((item) => item.available),
        running: health.ok,
        url: health.ok ? `http://127.0.0.1:${(await this.loadHostState()).port}/` : undefined,
        message: missing.length ? missing.map((item) => item.message || `${item.name} 필요`).join(' · ') : health.ok ? 'Loops 엔진 실행 중' : 'Loops 엔진을 시작할 수 있습니다.',
        root: this.runtime,
        prerequisites
      }
    } catch (error) {
      return { available: false, running: false, message: error instanceof Error ? error.message : String(error), root: this.runtime, prerequisites: [] }
    }
  }

  async start(): Promise<EngineStatus> {
    if (this.starting) return this.starting
    this.starting = (async () => {
      await this.prepare()
      const prerequisites = await this.prerequisites()
      const required = prerequisites.slice(0, 7).filter((item) => !item.available)
      if (required.length) throw new Error(required.map((item) => `${item.name}: ${item.message || '사용할 수 없음'}`).join(' · '))
      const state = await this.loadHostState()
      await rm(join(this.runtime, 'state', 'STOPPED.dashboard'), { force: true })
      if (!(await this.dashboardHealth()).ok) {
        const socket = createConnection({ host: '127.0.0.1', port: state.port })
        let occupied = true
        try { await once(socket, 'connect', { signal: AbortSignal.timeout(1200) }) } catch { occupied = false } finally { socket.destroy() }
        if (occupied) {
          state.port = await freePort()
          this.preparedSignature = undefined
          await this.prepare()
        }
        const command = `source ${shellQuote(join(this.runtime, 'bin', '_common.sh'))}; exec node ${shellQuote(join(this.runtime, 'dashboard-server.mjs'))}`
        const spawnResult = await runCapture(`${shellQuote(join(this.runtime, 'bin', 'spawn-panel.sh'))} ${shellQuote(this.runtime)} ${shellQuote(command)} ${shellQuote('📊 loops dashboard')}`, this.runtime, undefined, 20_000)
        if (spawnResult.code !== 0) throw new Error(`Loops 대시보드 시작 실패: ${(spawnResult.stderr || spawnResult.stdout).trim()}`)
        state.dashboardRef = (spawnResult.stdout.match(/workspace:\d+/) ?? [])[0]
        await this.saveHostState()
        let ready = false
        for (let attempt = 0; attempt < 30; attempt++) {
          const health = await this.dashboardHealth()
          if (health.ok) { ready = true; state.dashboardPid = health.pid; break }
          await delay(300)
        }
        if (!ready) throw new Error('Loops 대시보드가 시작되었지만 준비 상태를 확인하지 못했습니다.')
      }
      const pidFile = join(this.runtime, 'state', 'dispatcher.pid')
      let dispatcherPid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim())
      let dispatcherAlive = Number.isInteger(dispatcherPid) && dispatcherPid > 1
      if (dispatcherAlive) { try { process.kill(dispatcherPid, 0) } catch { dispatcherAlive = false } }
      if (dispatcherAlive) {
        if (!(await this.isDispatcher(dispatcherPid))) throw new Error('디스패처 PID가 이 엔진의 프로세스와 일치하지 않습니다. 기존 프로세스를 건드리지 않았습니다.')
        state.dispatcherPid = dispatcherPid
      } else {
        const result = await runCapture(`${shellQuote(join(this.runtime, 'loopctl'))} start`, this.runtime, undefined, 20_000)
        if (result.code !== 0) throw new Error(`Loops 디스패처 시작 실패: ${(result.stderr || result.stdout).trim()}`)
        dispatcherPid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim())
        if (Number.isInteger(dispatcherPid) && dispatcherPid > 1) state.dispatcherPid = dispatcherPid
      }
      await this.saveHostState()
      return this.status()
    })().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async isDispatcher(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 1) return false
    const result = await runCapture(`ps -p ${pid} -o command=`, this.runtime, undefined, 3_000)
    const canonical = await realpath(this.runtime)
    return result.code === 0 && [this.runtime, canonical].some((root) => result.stdout.includes(join(root, 'bin', 'dispatch.sh')))
  }

  async stop(): Promise<void> {
    await this.prepare()
    const state = await this.loadHostState()
    await writeFile(join(this.runtime, 'state', 'STOPPED.dashboard'), 'palace\n')
    const current = Number((await readFile(join(this.runtime, 'state', 'dispatcher.pid'), 'utf8').catch(() => '')).trim())
    if (await this.isDispatcher(current)) {
      await writeFile(join(this.runtime, 'state', 'STOPPED.dispatcher'), 'palace\n')
      try { process.kill(current, 'SIGTERM') } catch { /* 이미 종료됨 */ }
    }
    delete state.dispatcherPid
    if (state.dashboardRef && /^workspace:\d+$/.test(state.dashboardRef)) {
      await runCapture(`cmux close-workspace --workspace ${shellQuote(state.dashboardRef)}`, this.runtime, undefined, 8_000)
      delete state.dashboardRef
    }
    const dashboard = await this.dashboardHealth()
    if (state.dashboardPid && dashboard.ok && dashboard.pid === state.dashboardPid) {
      try { process.kill(state.dashboardPid, 'SIGTERM') } catch { /* 이미 종료됨 */ }
    }
    delete state.dashboardPid
    await this.saveHostState()
  }

  async proxy(input: { path: string; method: string; headers?: Record<string, string>; body?: Buffer }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    await this.prepare()
    const state = await this.loadHostState()
    const method = input.method.toUpperCase()
    if (!['GET', 'HEAD', 'POST'].includes(method)) throw new Error('Loops 프록시는 GET/HEAD/POST만 허용합니다.')
    if (!input.path.startsWith('/') || input.path.startsWith('//') || input.path.includes('\\') || input.path.split(/[?#]/, 1)[0].split('/').includes('..')) throw new Error('Loops 요청 경로가 안전하지 않습니다.')
    if (!(await this.dashboardHealth()).ok) throw new Error('Loops 엔진이 실행 중이 아닙니다.')
    const headers: Record<string, string> = { 'x-palace-engine-proxy': '1', authorization: `Bearer ${state.token}` }
    for (const key of ['accept', 'accept-language', 'content-type', 'if-none-match', 'if-modified-since']) {
      const value = input.headers?.[key]
      if (value) headers[key] = value
    }
    const response = await fetch(`http://127.0.0.1:${state.port}${input.path}`, { method, headers, body: method === 'POST' ? input.body as Uint8Array<ArrayBuffer> | undefined : undefined, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
    const outputHeaders: Record<string, string> = {}
    for (const key of ['content-type', 'cache-control', 'etag', 'last-modified', 'location']) {
      const value = response.headers.get(key)
      if (value) outputHeaders[key] = value
    }
    return { status: response.status, headers: outputHeaders, body: Buffer.from(await response.arrayBuffer()) }
  }

  async request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const response = await this.proxy({ path, method, headers: payload ? { 'content-type': 'application/json' } : undefined, body: payload })
    if (response.status < 200 || response.status >= 300) throw new Error(`Loops 요청 실패 (${response.status}): ${response.body.toString('utf8').slice(0, 1000)}`)
    const contentType = response.headers['content-type'] || ''
    if (contentType.includes('application/json')) return JSON.parse(response.body.toString('utf8'))
    return response.body.toString('utf8')
  }

  private projectAlias(path: string): string {
    const target = resolve(path)
    for (const [alias, configured] of Object.entries(this.options.getSettings().projectPaths)) if (resolve(configured) === target) return alias
    throw new Error(`Loops repo '${path}'를 이식할 수 없습니다. 환경 설정에서 이 프로젝트 폴더에 별칭을 먼저 지정하세요.`)
  }

  private machineIndependentConfig(input: Record<string, unknown>, label: string): Record<string, unknown> {
    const config = record(input, label)
    delete config.orchestratorWorktree
    delete config.worktreePrefix
    delete config.ompCommand
    delete config.enabled
    return config
  }

  private assertPortableConfig(config: Record<string, unknown>, id: string): void {
    assertPortableValue(config, `Loops ${id}`)
    if (typeof config.repo === 'string' && config.repo && (!config.repo.startsWith('project:') || config.repo.length === 'project:'.length)) {
      throw new Error(`Loops ${id} repo는 project:<별칭> 형식이어야 합니다.`)
    }
  }

  private portableConfig(input: Record<string, unknown>, label: string): Record<string, unknown> {
    const config = this.machineIndependentConfig(input, label)
    if (typeof config.repo === 'string' && config.repo && !config.repo.startsWith('project:')) config.repo = `project:${this.projectAlias(config.repo)}`
    assertPortableValue(config, label)
    return config
  }

  private resolveConfig(input: Record<string, unknown>, id: string, worktrees = true): { config: Record<string, unknown>; missing?: string } {
    const config = this.machineIndependentConfig(input, `Loops ${id}`)
    this.assertPortableConfig(config, id)
    if (typeof config.repo === 'string' && config.repo) {
      const alias = config.repo.slice('project:'.length)
      const path = this.options.getSettings().projectPaths[alias]
      if (!path) return { config, missing: alias }
      config.repo = path
    }
    if (worktrees) {
      config.orchestratorWorktree = join(this.runtime, 'worktrees', `loop-${id}`)
      config.worktreePrefix = join(this.runtime, 'worktrees', `loop-${id}`)
    }
    return { config }
  }

  private processAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false
    try { process.kill(pid, 0); return true } catch { return false }
  }

  private async loopActivity(id: string): Promise<string[]> {
    const activity: string[] = []
    const lock = join('/tmp', `loop-${id}.lockdir`)
    if (await fileExists(lock)) {
      const owner = Number((await readFile(join(lock, 'owner.pid'), 'utf8').catch(() => '')).trim())
      if (this.processAlive(owner)) activity.push(`orchestrator(pid ${owner})`)
      else if (!Number.isSafeInteger(owner) || owner <= 1) activity.push('orchestrator lock(owner 확인 중)')
    }
    for (const group of ['live', 'validate', 'verify']) {
      const directory = join(this.runtime, 'loops', id, 'state', group)
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.pid')) continue
        const pid = Number((await readFile(join(directory, entry.name), 'utf8').catch(() => '')).trim())
        if (this.processAlive(pid)) activity.push(`${group}/${entry.name}(pid ${pid})`)
      }
    }
    return activity
  }

  private async retireDefinition(kind: 'loops' | 'products', id: string): Promise<void> {
    const archive = join(this.runtime, 'state', 'retired', kind)
    await mkdir(archive, { recursive: true })
    const suffix = `${Date.now()}-${randomBytes(4).toString('hex')}`
    await rename(join(this.runtime, kind, id), join(archive, `${id}-${suffix}`))
  }

  async exportPortable(): Promise<PortableEngine> {
    await this.prepare()
    const deferred = await readJson<PortableEngine>(this.deferredPath)
    const output: PortableEngine = { loops: {}, products: {} }
    for (const entry of await readdir(join(this.runtime, 'products'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
      const value = await readJson<Record<string, unknown>>(join(this.runtime, 'products', entry.name, 'product.json'))
      if (!value) throw new Error(`제품 ${entry.name}: product.json을 읽을 수 없어 동기화하지 않았습니다.`)
      output.products[entry.name] = this.portableConfig(value, `제품 ${entry.name}`)
    }
    for (const entry of await readdir(join(this.runtime, 'loops'), { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
      const directory = join(this.runtime, 'loops', entry.name)
      const config = await readJson<Record<string, unknown>>(join(directory, 'config.json'))
      if (!config) throw new Error(`루프 ${entry.name}: config.json을 읽을 수 없어 동기화하지 않았습니다.`)
      const mission = await readFile(join(directory, 'mission.md'), 'utf8')
      const vision = await readOptionalText(join(directory, 'vision.md'))
      assertPortableValue(mission, `루프 ${entry.name} mission`)
      if (vision !== undefined) assertPortableValue(vision, `루프 ${entry.name} vision`)
      output.loops[entry.name] = { config: this.portableConfig(config, `루프 ${entry.name}`), mission, ...(vision === undefined ? {} : { vision }) }
    }
    for (const [id, raw] of Object.entries(deferred?.products ?? {})) {
      assertId(id, '제품')
      const config = this.machineIndependentConfig(raw, `제품 ${id}`)
      this.assertPortableConfig(config, id)
      output.products[id] = config
    }
    for (const [id, rawValue] of Object.entries(deferred?.loops ?? {})) {
      assertId(id, '루프')
      const raw = record(rawValue, `루프 ${id}`) as unknown as PortableLoop
      if (typeof raw.mission !== 'string' || (raw.vision !== undefined && typeof raw.vision !== 'string')) throw new Error(`루프 ${id} 프롬프트가 올바르지 않습니다.`)
      assertPortableValue(raw.mission, `루프 ${id} mission`)
      if (raw.vision !== undefined) assertPortableValue(raw.vision, `루프 ${id} vision`)
      const config = this.machineIndependentConfig(raw.config, `루프 ${id} config`)
      this.assertPortableConfig(config, id)
      output.loops[id] = { config, mission: raw.mission, ...(raw.vision === undefined ? {} : { vision: raw.vision }) }
    }
    return output
  }

  async importPortable(value: PortableEngine): Promise<void> {
    await this.prepare()
    const input = record(value, 'Loops portable profile') as unknown as PortableEngine
    const loops = record(input.loops, 'Loops portable loops') as PortableEngine['loops']
    const products = record(input.products, 'Loops portable products') as PortableEngine['products']
    const deferred: PortableEngine = { loops: {}, products: {} }
    const changedProducts = new Set<string>()
    const activeProductIds = (await readdir(join(this.runtime, 'products'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name)).map((entry) => entry.name)
    const activeLoopIds = (await readdir(join(this.runtime, 'loops'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && ID_PATTERN.test(entry.name)).map((entry) => entry.name)

    type StagedProduct = {
      id: string
      config?: Record<string, unknown>
      missing?: string
    }
    type StagedLoop = {
      id: string
      portable: PortableLoop
      config?: Record<string, unknown>
      current?: Record<string, unknown>
      changed: boolean
    }
    const stagedProducts = new Map<string, StagedProduct>()
    const stagedLoops = new Map<string, StagedLoop>()

    for (const [id, raw] of Object.entries(products)) {
      assertId(id, '제품')
      const portable = this.machineIndependentConfig(raw, `제품 ${id}`)
      const resolved = this.resolveConfig(portable, id, false)
      const current = await readJson<Record<string, unknown>>(join(this.runtime, 'products', id, 'product.json'))
      let currentPortable: Record<string, unknown> | undefined
      try { currentPortable = current ? this.portableConfig(current, `제품 ${id}`) : undefined } catch { currentPortable = undefined }
      if (!currentPortable || stable(currentPortable) !== stable(portable)) changedProducts.add(id)
      if (resolved.missing) {
        deferred.products[id] = clone(portable)
        stagedProducts.set(id, { id, missing: resolved.missing })
        continue
      }
      if (current && typeof current.ompCommand === 'string') resolved.config.ompCommand = current.ompCommand
      if (current && typeof current.enabled === 'boolean') resolved.config.enabled = current.enabled
      stagedProducts.set(id, { id, config: resolved.config })
    }

    for (const [id, rawValue] of Object.entries(loops)) {
      assertId(id, '루프')
      const raw = record(rawValue, `루프 ${id}`) as unknown as PortableLoop
      if (typeof raw.mission !== 'string' || (raw.vision !== undefined && typeof raw.vision !== 'string')) throw new Error(`루프 ${id} 프롬프트가 올바르지 않습니다.`)
      assertPortableValue(raw.mission, `루프 ${id} mission`)
      if (raw.vision !== undefined) assertPortableValue(raw.vision, `루프 ${id} vision`)
      const rawConfig = this.machineIndependentConfig(raw.config, `루프 ${id} config`)
      const productValue = rawConfig.product
      if (productValue !== undefined && (typeof productValue !== 'string' || !ID_PATTERN.test(productValue))) throw new Error(`루프 ${id} product id가 올바르지 않습니다.`)
      const product = typeof productValue === 'string' ? productValue : undefined
      if (product && !Object.hasOwn(products, product)) throw new Error(`루프 ${id}가 제품 '${product}'을 사용하지만 portable products에 정의가 없습니다.`)
      const portable: PortableLoop = { config: clone(rawConfig), mission: raw.mission, ...(raw.vision === undefined ? {} : { vision: raw.vision }) }
      const resolved = this.resolveConfig(rawConfig, id)
      const productStage = product ? stagedProducts.get(product) : undefined
      const missing = resolved.missing ?? productStage?.missing
      const directory = join(this.runtime, 'loops', id)
      const current = await readJson<Record<string, unknown>>(join(directory, 'config.json'))
      if (missing) {
        deferred.loops[id] = portable
        stagedLoops.set(id, { id, portable, current, changed: true })
        continue
      }
      const currentMission = await readOptionalText(join(directory, 'mission.md'))
      const currentVision = await readOptionalText(join(directory, 'vision.md'))
      let currentPortable: Record<string, unknown> | undefined
      try { currentPortable = current ? this.portableConfig(current, `루프 ${id}`) : undefined } catch { currentPortable = undefined }
      const changed = !currentPortable || stable(currentPortable) !== stable(rawConfig) || currentMission !== raw.mission || currentVision !== raw.vision || (product ? changedProducts.has(product) : false)
      if (current && typeof current.ompCommand === 'string') resolved.config.ompCommand = current.ompCommand
      for (const key of ['orchestratorWorktree', 'worktreePrefix']) if (current && typeof current[key] === 'string') resolved.config[key] = current[key]
      if (changed) resolved.config.enabled = false
      else if (current && typeof current.enabled === 'boolean') resolved.config.enabled = current.enabled
      stagedLoops.set(id, { id, portable, config: resolved.config, current, changed })
    }

    const loopsToRetire = activeLoopIds.filter((id) => !stagedLoops.get(id)?.config)
    const productsToRetire = activeProductIds.filter((id) => !stagedProducts.get(id)?.config)
    const conflicts: string[] = []
    for (const id of activeLoopIds) {
      const staged = stagedLoops.get(id)
      const removing = !staged?.config
      if (!removing && !staged.changed) continue
      const current = staged?.current ?? await readJson<Record<string, unknown>>(join(this.runtime, 'loops', id, 'config.json'))
      const activity = await this.loopActivity(id)
      if (removing && current?.enabled !== false) conflicts.push(`${id}: enabled 루프는 제거/보류할 수 없습니다. 먼저 비활성화하세요.`)
      if (activity.length) conflicts.push(`${id}: ${removing ? '제거/보류' : '정의 변경'} 전에 실행 중 작업을 완료하세요 (${activity.join(', ')})`)
    }
    if (conflicts.length) throw new Error(`Loops portable 적용을 안전하게 진행할 수 없습니다.\n- ${conflicts.join('\n- ')}`)

    for (const staged of stagedLoops.values()) {
      if (!staged.config || !staged.changed) continue
      const directory = join(this.runtime, 'loops', staged.id)
      await mkdir(join(directory, 'state'), { recursive: true })
      await writeFile(join(directory, 'config.json'), JSON.stringify(staged.config, null, 2) + '\n')
      await writeFile(join(directory, 'mission.md'), staged.portable.mission)
      if (staged.portable.vision === undefined) await rm(join(directory, 'vision.md'), { force: true })
      else await writeFile(join(directory, 'vision.md'), staged.portable.vision)
    }
    for (const staged of stagedProducts.values()) {
      if (!staged.config || !changedProducts.has(staged.id)) continue
      const directory = join(this.runtime, 'products', staged.id)
      await mkdir(join(directory, 'state'), { recursive: true })
      await writeFile(join(directory, 'product.json'), JSON.stringify(staged.config, null, 2) + '\n')
    }
    for (const id of loopsToRetire) await this.retireDefinition('loops', id)
    for (const id of productsToRetire) await this.retireDefinition('products', id)
    if (Object.keys(deferred.loops).length || Object.keys(deferred.products).length) await writeFile(this.deferredPath, JSON.stringify(deferred, null, 2) + '\n', { mode: 0o600 })
    else await rm(this.deferredPath, { force: true })
  }
}
