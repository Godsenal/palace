import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { access, chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { MachineSettings, PortableProfile } from '../../shared/automation'
import type {
  AgentProfile,
  CmuxWorkspace,
  NativeOmpHost,
  NativeOmpLaunch,
  NativeOmpLink,
  RemoteAPI,
  RemoteStatus
} from '../../shared/workbench'
import { detectShell, primeShellPath } from '../exec'
import { shellCommand, shellQuote } from '../automation/rpc'
import { materializeSessionRuntime } from './ide-profile'

const COMMAND_TIMEOUT_MS = 5_000
const COMMAND_OUTPUT_LIMIT = 1024 * 1024
const STATUS_CACHE_MS = 1_500
const MAX_HOSTS = 512
const MAX_WORKSPACES = 2_048
const MAX_LAUNCHES = 512
const WORKSPACE_REF = /^workspace:\d+$/
const INSTANCE_ID = /^[a-z0-9-]{8,64}$/

interface NativeOmpRemoteServiceOptions {
  root: string
  getSettings(): MachineSettings
  getOmp(): PortableProfile['omp']
  getProfiles(): Promise<AgentProfile[]>
  engineSource: string
}

interface CommandResult {
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  overflowed: boolean
}
interface PromiseResolvers<T> {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

const PromiseWithResolvers = Promise as PromiseConstructor & {
  withResolvers<T>(): PromiseResolvers<T>
}


interface OwnedLaunch {
  id: string
  workspaceRef: string
  cwd: string
  pid: number
  processStarted: string
  createdAt: number
}

interface StoredLaunches {
  version: 1
  launches: OwnedLaunch[]
}


function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
function metadataString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 1_024) throw new Error(`${label} 형식이 올바르지 않습니다.`)
  return value
}

function boundedString(value: unknown, label: string, maximum = 1_024): string {
  if (typeof value !== 'string') throw new Error(`${label}이(가) 문자열이 아닙니다.`)
  const text = value.trim()
  if (!text || text.includes('\0') || /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || Buffer.byteLength(text, 'utf8') > maximum) {
    throw new Error(`${label}이(가) 비어 있거나 올바르지 않습니다.`)
  }
  return text
}

function safeDiagnostic(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320)
}

function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { /* process already exited */ }
  }
}

async function runBounded(command: string, cwd?: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  const shell = detectShell()
  const path = await primeShellPath(shell)
  const env = path ? { ...process.env, PATH: path } : process.env
  const { promise, resolve: resolveResult } = PromiseWithResolvers.withResolvers<CommandResult>()
  const child = spawn(shell, ['-l', '-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let timedOut = false
    let overflowed = false
    let settled = false
    let hardKill: NodeJS.Timeout | undefined

    const stop = (): void => {
      terminate(child, 'SIGTERM')
      hardKill = setTimeout(() => {
        if (!settled) terminate(child, 'SIGKILL')
      }, 1_000)
      hardKill.unref?.()
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (overflowed) return
      bytes += chunk.byteLength
      if (bytes > COMMAND_OUTPUT_LIMIT) {
        overflowed = true
        stop()
        return
      }
      if (target === 'stdout') stdout += chunk.toString()
      else stderr += chunk.toString()
    }
    const done = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (hardKill) clearTimeout(hardKill)
      resolveResult({ code, stdout, stderr, timedOut, overflowed })
    }

  child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk))
  child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk))
  child.on('error', (error) => {
    stderr += String(error)
    done(127)
  })
  child.on('close', (code) => done(code ?? 1))
  return promise
}

function commandFailure(result: CommandResult, subject: string): Error {
  if (result.timedOut) return new Error(`${subject} 응답 시간이 초과되었습니다.`)
  if (result.overflowed) return new Error(`${subject} 응답이 허용 크기를 초과했습니다.`)
  const detail = safeDiagnostic(result.stderr || result.stdout)
  return new Error(detail ? `${subject} 실행에 실패했습니다: ${detail}` : `${subject} 실행에 실패했습니다.`)
}

function parseHost(value: unknown): NativeOmpHost {
  const host = record(value)
  if (!host) throw new Error('OMP Collab 호스트 메타데이터 형식이 올바르지 않습니다.')
  const instanceId = boundedString(host.instanceId, 'OMP 인스턴스 ID', 64)
  if (!INSTANCE_ID.test(instanceId)) throw new Error('OMP 인스턴스 ID 형식이 올바르지 않습니다.')
  if (!Number.isSafeInteger(host.generation) || (host.generation as number) < 1) throw new Error('OMP Collab generation이 올바르지 않습니다.')
  if (!Number.isSafeInteger(host.pid) || (host.pid as number) <= 0) throw new Error('OMP Collab PID가 올바르지 않습니다.')
  const sessionId = metadataString(host.sessionId, 'OMP 세션 ID')
  const sessionName = host.sessionName === null ? null : metadataString(host.sessionName, 'OMP 세션 이름')
  const cwd = metadataString(host.cwd, 'OMP 작업 폴더')
  let model: NativeOmpHost['model'] = null
  if (host.model !== null) {
    const candidate = record(host.model)
    if (!candidate) throw new Error('OMP 모델 메타데이터 형식이 올바르지 않습니다.')
    model = {
      provider: metadataString(candidate.provider, 'OMP 모델 공급자'),
      id: metadataString(candidate.id, 'OMP 모델 ID')
    }
  }
  if (typeof host.startedAt !== 'number' || !Number.isFinite(host.startedAt) || host.startedAt < 0) throw new Error('OMP Collab 시작 시간이 올바르지 않습니다.')
  if (!Number.isSafeInteger(host.participants) || (host.participants as number) < 0) throw new Error('OMP Collab 참가자 수가 올바르지 않습니다.')
  if (typeof host.relayConnected !== 'boolean' || typeof host.inputRequired !== 'boolean') throw new Error('OMP Collab 상태 형식이 올바르지 않습니다.')
  if (host.access !== 'view' && host.access !== 'control') throw new Error('OMP Collab 접근 수준이 올바르지 않습니다.')
  return {
    instanceId,
    generation: host.generation as number,
    pid: host.pid as number,
    sessionId,
    sessionName,
    cwd,
    model,
    startedAt: host.startedAt,
    participants: host.participants as number,
    relayConnected: host.relayConnected,
    inputRequired: host.inputRequired,
    access: host.access
  }
}

function parseHosts(output: string): NativeOmpHost[] {
  let value: unknown
  try { value = JSON.parse(output) } catch { throw new Error('OMP Collab 목록의 JSON 응답을 읽을 수 없습니다.') }
  const payload = record(value)
  if (!payload || payload.version !== 1 || !Array.isArray(payload.hosts) || payload.hosts.length > MAX_HOSTS) {
    throw new Error('지원하지 않는 OMP Collab 목록 응답입니다. OMP를 최신 버전으로 업데이트하세요.')
  }
  const seen = new Set<string>()
  const hosts: NativeOmpHost[] = []
  for (const value of payload.hosts) {
    const host = parseHost(value)
    if (seen.has(host.instanceId)) throw new Error('OMP Collab 목록에 중복 인스턴스가 있습니다.')
    seen.add(host.instanceId)
    hosts.push(host)
  }
  return hosts
}

function parseWorkspaces(output: string): CmuxWorkspace[] {
  let value: unknown
  try { value = JSON.parse(output) } catch { throw new Error('cmux 워크스페이스 JSON 응답을 읽을 수 없습니다.') }
  const payload = record(value)
  if (!payload || !Array.isArray(payload.workspaces) || payload.workspaces.length > MAX_WORKSPACES) throw new Error('cmux 워크스페이스 응답 형식이 올바르지 않습니다.')
  const seen = new Set<string>()
  const workspaces: CmuxWorkspace[] = []
  for (const value of payload.workspaces) {
    const workspace = record(value)
    if (!workspace) throw new Error('cmux 워크스페이스 메타데이터 형식이 올바르지 않습니다.')
    const ref = boundedString(workspace.ref, 'cmux 워크스페이스 참조', 128)
    if (!WORKSPACE_REF.test(ref)) throw new Error('cmux 워크스페이스 참조 형식이 올바르지 않습니다.')
    if (seen.has(ref)) continue
    seen.add(ref)
    const title = typeof workspace.title === 'string' && workspace.title.trim()
      ? boundedString(workspace.title, 'cmux 워크스페이스 제목', 1_024)
      : 'Terminal'
    const cwd = typeof workspace.current_directory === 'string' && workspace.current_directory.trim()
      ? boundedString(workspace.current_directory, 'cmux 작업 폴더', 8_192)
      : ''
    workspaces.push({ ref, title, cwd })
  }
  return workspaces
}

function parseOwnedLaunch(value: unknown): OwnedLaunch | undefined {
  const item = record(value)
  if (!item || typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/.test(item.id)) return undefined
  if (typeof item.workspaceRef !== 'string' || !WORKSPACE_REF.test(item.workspaceRef)) return undefined
  if (typeof item.cwd !== 'string' || !item.cwd || item.cwd.includes('\0')) return undefined
  if (!Number.isSafeInteger(item.pid) || (item.pid as number) <= 0) return undefined
  if (typeof item.processStarted !== 'string' || !item.processStarted.trim()) return undefined
  if (typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)) return undefined
  return {
    id: item.id,
    workspaceRef: item.workspaceRef,
    cwd: item.cwd,
    pid: item.pid as number,
    processStarted: item.processStarted,
    createdAt: item.createdAt
  }
}

function safeBrowserUrl(value: unknown): string {
  const raw = boundedString(value, 'OMP Collab 링크', 32_768)
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('OMP가 안전하지 않은 Collab 링크를 반환했습니다.') }
  const localhost = url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) throw new Error('OMP Collab 링크는 HTTPS여야 합니다. 로컬 개발용 localhost HTTP만 예외입니다.')
  if (url.username || url.password) throw new Error('사용자 정보가 포함된 OMP Collab 링크는 열 수 없습니다.')
  return raw
}

export class NativeOmpRemoteService implements RemoteAPI {
  private readonly root: string
  private readonly runtimeRoot: string
  private readonly launchesFile: string
  private readonly engineSource: string
  private statusCache?: { at: number; value: RemoteStatus }
  private statusLoading?: Promise<RemoteStatus>
  private metadataTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: NativeOmpRemoteServiceOptions) {
    this.root = resolve(options.root)
    this.runtimeRoot = join(this.root, 'workbench', 'native-omp')
    this.launchesFile = join(this.root, 'workbench', 'native-omp-launches.json')
    this.engineSource = resolve(options.engineSource)
  }

  async status(): Promise<RemoteStatus> {
    if (this.statusCache && Date.now() - this.statusCache.at < STATUS_CACHE_MS) return clone(this.statusCache.value)
    if (this.statusLoading) return clone(await this.statusLoading)
    this.statusLoading = this.loadStatus().then((value) => {
      this.statusCache = { at: Date.now(), value }
      return value
    }).finally(() => { this.statusLoading = undefined })
    return clone(await this.statusLoading)
  }

  async launch(input: NativeOmpLaunch): Promise<{ workspaceRef: string; cwd: string; pid?: number; message?: string }> {
    if (!input || typeof input !== 'object') throw new Error('OMP 실행 요청이 올바르지 않습니다.')
    const project = boundedString(input.project, '프로젝트 별칭', 256)
    if (input.access !== 'off' && input.access !== 'view' && input.access !== 'control') throw new Error('Native Collab 접근 수준을 선택하세요.')

    const settings = this.options.getSettings()
    const configured = settings.projectPaths[project]
    if (!configured) throw new Error(`등록되지 않은 프로젝트입니다: ${project}. 환경 설정에서 프로젝트 별칭을 먼저 연결하세요.`)
    const cwd = await realpath(resolve(configured)).catch(() => null)
    if (!cwd) throw new Error(`프로젝트 폴더를 찾을 수 없습니다: ${project}. 환경 설정의 경로를 확인하세요.`)
    const projectInfo = await stat(cwd).catch(() => null)
    if (!projectInfo?.isDirectory()) throw new Error(`등록된 프로젝트 경로가 디렉터리가 아닙니다: ${project}`)

    const profiles = await this.options.getProfiles()
    let profile: AgentProfile | undefined
    if (input.profileId !== undefined) {
      const profileId = boundedString(input.profileId, '에이전트 프로필 ID', 256)
      profile = profiles.find((candidate) => candidate.id === profileId)
      if (!profile) throw new Error(`선택한 에이전트 프로필을 찾을 수 없습니다: ${profileId}. 프로필 목록을 새로 고치세요.`)
    }
    const selectedModel = input.model === undefined
      ? (profile?.model.trim() || 'auto')
      : boundedString(input.model, '모델', 1_024)
    const ompCommand = settings.ompCommand.trim()
    if (!ompCommand) throw new Error('OMP 실행 명령이 구성되지 않았습니다. 환경 설정에서 OMP 명령을 지정하세요.')

    const cmux = await this.cmuxBinary()
    const spawnPanel = join(this.engineSource, 'bin', 'spawn-panel.sh')
    await access(spawnPanel, constants.R_OK).catch(() => {
      throw new Error(`cmux 실행 도우미를 찾을 수 없습니다: ${spawnPanel}. Palace 엔진 설치를 확인하세요.`)
    })

    const id = randomUUID()
    const omp = clone(this.options.getOmp())
    const currentCollab = record(omp.config.collab)
    omp.config.collab = { ...(currentCollab ? clone(currentCollab) : {}), autoStart: input.access }
    const runtime = await materializeSessionRuntime({
      runtimeRoot: this.runtimeRoot,
      sessionId: id,
      workspaceCwd: cwd,
      projectSkills: join(cwd, '.agent', 'skills'),
      omp,
      profile
    })

    const argv = [ompCommand, '--config', runtime.configPath, '--session-dir', runtime.sessionsDirectory, '--no-title']
    if (runtime.instructionsPath) argv.push('--append-system-prompt', runtime.instructionsPath)
    if (selectedModel.toLowerCase() !== 'auto') argv.push('--model', selectedModel)
    const thinking = profile?.thinking.trim()
    if (thinking && thinking.toLowerCase() !== 'auto') argv.push('--thinking', boundedString(thinking, '프로필 thinking', 128))

    const acknowledgement = join(runtime.directory, 'launch.pid')
    const interactiveCommand = [
      'umask 077',
      `printf '%s\\n' "$$" > ${shellQuote(acknowledgement)}`,
      `exec ${shellCommand(argv)}`
    ].join(' && ')
    const titleProject = project.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 80)
    const spawnResult = await runBounded(
      `CMUX_BIN=${shellQuote(cmux)} /bin/zsh ${shellQuote(spawnPanel)} ${shellQuote(cwd)} ${shellQuote(interactiveCommand)} ${shellQuote(`OMP · ${titleProject}`)}`,
      cwd,
      20_000
    )
    if (spawnResult.code !== 0) throw commandFailure(spawnResult, 'cmux OMP 워크스페이스 생성')
    const workspaceRef = spawnResult.stdout.match(/workspace:\d+/)?.[0]
    if (!workspaceRef) throw new Error('cmux가 새 워크스페이스 참조를 반환하지 않았습니다. cmux를 열고 다시 시도하세요.')

    const pid = await this.waitForPid(acknowledgement)
    const identity = await this.waitForProcessIdentity(pid, runtime.configPath)
    await this.appendOwnedLaunch({ id, workspaceRef, cwd, pid, processStarted: identity.started, createdAt: Date.now() })
    this.statusCache = undefined

    if (input.access === 'off') return { workspaceRef, cwd, pid, message: 'OMP가 cmux에서 시작되었습니다. Native Collab 공유는 꺼져 있습니다.' }
    const host = await this.waitForHost(pid)
    if (!host) {
      return { workspaceRef, cwd, pid, message: 'OMP가 cmux에서 시작되었습니다. Native Collab은 백그라운드에서 연결 중입니다. 잠시 후 새로 고치세요.' }
    }
    if (!host.relayConnected) {
      return { workspaceRef, cwd, pid, message: 'OMP Native Collab 호스트가 등록되었지만 릴레이에 다시 연결 중입니다.' }
    }
    return { workspaceRef, cwd, pid, message: 'OMP가 cmux에서 시작되었고 Native Collab 호스트가 등록되었습니다.' }
  }

  async link(instanceIdInput: string, generation: number, accessLevel: 'view' | 'control'): Promise<NativeOmpLink> {
    const instanceId = boundedString(instanceIdInput, 'OMP 인스턴스 ID', 256)
    if (!INSTANCE_ID.test(instanceId)) throw new Error('OMP 인스턴스 ID 형식이 올바르지 않습니다.')
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('OMP Collab generation이 올바르지 않습니다.')
    if (accessLevel !== 'view' && accessLevel !== 'control') throw new Error('OMP Collab 접근 수준이 올바르지 않습니다.')

    const observed = (await this.queryOmpHosts()).find((host) => host.instanceId === instanceId)
    if (!observed) throw new Error('선택한 OMP Collab 호스트가 더 이상 없습니다. 목록을 새로 고치세요.')
    if (observed.generation !== generation) throw new Error('선택한 OMP 세션이 변경되었습니다. 새 세션의 링크를 노출하지 않았습니다. 목록을 새로 고치세요.')
    if (accessLevel === 'control' && observed.access !== 'control') throw new Error('이 OMP 호스트는 보기 전용으로 공유되었습니다. 보기 링크를 선택하세요.')

    const args = ['collab', 'link', instanceId, '--json']
    if (accessLevel === 'view') args.push('--view')
    const result = await this.runOmp(args)
    if (result.code !== 0 || result.timedOut || result.overflowed) {
      throw new Error('OMP Collab 링크를 가져오지 못했습니다. 호스트 상태와 generation을 새로 고친 뒤 다시 시도하세요.')
    }
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch { throw new Error('OMP Collab 링크 응답을 읽을 수 없습니다.') }
    const payload = record(parsed)
    if (!payload || payload.version !== 1 || payload.instanceId !== instanceId || payload.generation !== generation || payload.access !== accessLevel) {
      throw new Error('OMP 세션이 링크 요청 중 변경되었습니다. 후속 세션의 링크를 노출하지 않았습니다. 목록을 새로 고치세요.')
    }
    const url = safeBrowserUrl(payload.url)
    return { instanceId, generation, access: accessLevel, url }
  }

  async focus(workspaceRefInput: string): Promise<void> {
    const workspaceRef = boundedString(workspaceRefInput, 'cmux 워크스페이스 참조', 128)
    if (!WORKSPACE_REF.test(workspaceRef)) throw new Error('cmux 워크스페이스 참조 형식이 올바르지 않습니다.')
    const cmux = await this.cmuxBinary()
    const workspaces = await this.queryCmuxWorkspaces(cmux)
    if (!workspaces.some((workspace) => workspace.ref === workspaceRef)) throw new Error('선택한 cmux 워크스페이스가 더 이상 없습니다. 목록을 새로 고치세요.')
    const result = await runBounded(`${shellQuote(cmux)} select-workspace --workspace ${shellQuote(workspaceRef)}`)
    if (result.code !== 0 || result.timedOut || result.overflowed) throw commandFailure(result, 'cmux 워크스페이스 선택')
    this.statusCache = undefined
  }

  private async loadStatus(): Promise<RemoteStatus> {
    const [ompResult, cmuxResult] = await Promise.allSettled([
      this.queryOmpHosts(),
      this.cmuxBinary().then((binary) => this.queryCmuxWorkspaces(binary))
    ])
    const available = ompResult.status === 'fulfilled'
    const cmuxAvailable = cmuxResult.status === 'fulfilled'
    const hosts = available ? ompResult.value : []
    const workspaces = cmuxAvailable ? cmuxResult.value : []
    if (available && cmuxAvailable && hosts.length > 0) await this.attachOwnedWorkspaceRefs(hosts, workspaces)
    const messages: string[] = []
    if (ompResult.status === 'rejected') messages.push(ompResult.reason instanceof Error ? ompResult.reason.message : String(ompResult.reason))
    if (cmuxResult.status === 'rejected') messages.push(cmuxResult.reason instanceof Error ? cmuxResult.reason.message : String(cmuxResult.reason))
    return { available, cmuxAvailable, ...(messages.length ? { message: messages.join(' ') } : {}), hosts, workspaces }
  }

  private async runOmp(args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
    const command = this.options.getSettings().ompCommand.trim()
    if (!command) throw new Error('OMP 실행 명령이 구성되지 않았습니다. 환경 설정에서 OMP 명령을 지정하세요.')
    return runBounded(shellCommand([command, ...args]), undefined, timeoutMs)
  }

  private async queryOmpHosts(): Promise<NativeOmpHost[]> {
    const result = await this.runOmp(['collab', 'list', '--json'])
    if (result.code !== 0 || result.timedOut || result.overflowed) {
      const detail = result.code === 127 ? ' OMP 실행 파일을 찾을 수 없습니다.' : ''
      throw new Error(`${commandFailure(result, 'OMP Collab 목록').message}${detail} OMP 18.2.5 이상과 로그인을 확인하세요.`)
    }
    return parseHosts(result.stdout)
  }

  private async cmuxBinary(): Promise<string> {
    const bundled = '/Applications/cmux.app/Contents/Resources/bin/cmux'
    if (existsSync(bundled)) return bundled
    const result = await runBounded('command -v cmux')
    const path = result.stdout.trim().split(/\s+/)[0]
    if (result.code !== 0 || !path || path.includes('\0')) throw new Error('cmux 실행 파일을 찾을 수 없습니다. cmux를 설치하고 한 번 실행한 뒤 다시 시도하세요.')
    return path
  }

  private async queryCmuxWorkspaces(binary: string): Promise<CmuxWorkspace[]> {
    const result = await runBounded(`${shellQuote(binary)} --json workspace list`)
    if (result.code !== 0 || result.timedOut || result.overflowed) throw commandFailure(result, 'cmux 워크스페이스 목록')
    return parseWorkspaces(result.stdout)
  }

  private async waitForPid(path: string): Promise<number> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const raw = await readFile(path, 'utf8').catch(() => '')
      const pid = Number(raw.trim())
      if (Number.isSafeInteger(pid) && pid > 0) return pid
      await delay(250)
    }
    throw new Error('cmux 워크스페이스는 열렸지만 OMP 실행 확인을 받지 못했습니다. 새 탭의 오류를 확인하세요.')
  }

  private async processIdentity(pid: number): Promise<{ started: string; command: string } | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
    const marker = '__PALACE_OMP_COMMAND__'
    const result = await runBounded(`ps -p ${pid} -o lstart=; printf '\\n${marker}\\n'; ps -p ${pid} -o command=`)
    if (result.code !== 0 || result.timedOut || result.overflowed) return undefined
    const index = result.stdout.indexOf(`\n${marker}\n`)
    if (index < 0) return undefined
    const started = result.stdout.slice(0, index).trim()
    const command = result.stdout.slice(index + marker.length + 2).trim()
    return started && command ? { started, command } : undefined
  }

  private async waitForProcessIdentity(pid: number, configPath: string): Promise<{ started: string; command: string }> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const identity = await this.processIdentity(pid)
      if (identity?.command.includes(configPath)) return identity
      await delay(250)
    }
    throw new Error('cmux가 명령을 받았지만 Native OMP 프로세스가 시작되었는지 확인할 수 없습니다. 새 탭의 오류를 확인하세요.')
  }

  private async waitForHost(pid: number): Promise<NativeOmpHost | undefined> {
    for (const wait of [0, 250, 500, 1_000, 1_500]) {
      if (wait) await delay(wait)
      const hosts = await this.queryOmpHosts().catch(() => [])
      const host = hosts.find((candidate) => candidate.pid === pid)
      if (host) return host
    }
    return undefined
  }

  private async readOwnedLaunches(): Promise<OwnedLaunch[]> {
    await this.metadataTail
    let raw: string
    try { raw = await readFile(this.launchesFile, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error('Native OMP 실행 기록이 손상되었습니다.') }
    const payload = record(parsed)
    if (!payload || payload.version !== 1 || !Array.isArray(payload.launches) || payload.launches.length > MAX_LAUNCHES) {
      throw new Error('Native OMP 실행 기록 형식이 올바르지 않습니다.')
    }
    return payload.launches.map(parseOwnedLaunch).filter((value): value is OwnedLaunch => Boolean(value))
  }

  private async appendOwnedLaunch(launch: OwnedLaunch): Promise<void> {
    const operation = this.metadataTail.then(async () => {
      await mkdir(join(this.root, 'workbench'), { recursive: true, mode: 0o700 })
      await chmod(join(this.root, 'workbench'), 0o700)
      let launches: OwnedLaunch[] = []
      try {
        const raw = await readFile(this.launchesFile, 'utf8')
        const parsed = JSON.parse(raw) as StoredLaunches
        if (parsed.version !== 1 || !Array.isArray(parsed.launches)) throw new Error('format')
        launches = parsed.launches.map(parseOwnedLaunch).filter((value): value is OwnedLaunch => Boolean(value))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Native OMP 실행 기록을 읽을 수 없습니다. 손상된 기록을 확인하세요.')
      }
      launches = [...launches.filter((item) => item.id !== launch.id), launch].slice(-MAX_LAUNCHES)
      const temporary = `${this.launchesFile}.${process.pid}.${launch.id}.tmp`
      await writeFile(temporary, `${JSON.stringify({ version: 1, launches }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.launchesFile)
      await chmod(this.launchesFile, 0o600)
    })
    this.metadataTail = operation.catch(() => undefined)
    return operation
  }

  private async attachOwnedWorkspaceRefs(hosts: NativeOmpHost[], workspaces: CmuxWorkspace[]): Promise<void> {
    const launches = await this.readOwnedLaunches().catch(() => [])
    const liveRefs = new Set(workspaces.map((workspace) => workspace.ref))
    const candidates = new Map<number, OwnedLaunch>()
    for (const launch of launches) {
      if (!liveRefs.has(launch.workspaceRef)) continue
      const current = candidates.get(launch.pid)
      if (!current || current.createdAt < launch.createdAt) candidates.set(launch.pid, launch)
    }
    await Promise.all(hosts.map(async (host) => {
      const launch = candidates.get(host.pid)
      if (!launch) return
      const identity = await this.processIdentity(host.pid)
      const configPath = join(this.runtimeRoot, launch.id, 'config.json')
      if (identity?.started === launch.processStarted && identity.command.includes(configPath)) host.workspaceRef = launch.workspaceRef
    }))
  }
}

export type { NativeOmpRemoteServiceOptions }
