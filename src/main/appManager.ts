import { existsSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipboard } from 'electron'
import type { ChildProcess } from 'node:child_process'
import type {
  AppView,
  EnvEntry,
  EnvView,
  InstallState,
  LogLine,
  Manifest,
  PrereqResult,
  ProgressEvent,
  RunState,
  Settings
} from '../shared/types'
import { parseEnv, writeEnv as writeEnvFile } from './env'
import { loadManifests, resolveDir } from './registry'
import { fetchAndCompare, gitInfo, clone, toHttps, isGitRepo } from './git'
import { runCapture, runStreaming, spawnLongRunning, killGroup } from './exec'
import { isPortOpen } from './health'
import { renderMarkdown } from './markdown'

interface Managed {
  child: ChildProcess
  dir: string
}

export interface AppManagerDeps {
  getSettings: () => Settings
  emitLog: (l: LogLine) => void
  emitProgress: (p: ProgressEvent) => void
  emitState: () => void // 상태 변경 시 전체 재계산 후 renderer 로 push
}

export class AppManager {
  private managed = new Map<string, Managed>()
  private installBusy = new Set<string>()
  private starting = new Set<string>()
  private errors = new Map<string, string>()

  constructor(private deps: AppManagerDeps) {}

  private shell(): string | undefined {
    return this.deps.getSettings().shell
  }

  /** 외부(IPC)에서 상태 재계산·브로드캐스트를 트리거. */
  notifyState(): void {
    this.deps.emitState()
  }

  private log(appId: string, stream: string, line: string, level: 'info' | 'error' = 'info'): void {
    this.deps.emitLog({ appId, stream, line, level, ts: Date.now() })
  }

  private progress(p: Omit<ProgressEvent, never>): void {
    this.deps.emitProgress(p)
  }

  // ---- 상태 계산 ----

  async listApps(): Promise<AppView[]> {
    const manifests = loadManifests()
    return Promise.all(manifests.map((m) => this.buildView(m)))
  }

  async getApp(id: string): Promise<AppView | null> {
    const m = loadManifests().find((x) => x.id === id)
    return m ? this.buildView(m) : null
  }

  private async buildView(m: Manifest): Promise<AppView> {
    const settings = this.deps.getSettings()
    const { dir, installed } = resolveDir(m, settings)

    let installState: InstallState = installed ? 'installed' : 'not-installed'
    if (this.installBusy.has(m.id)) installState = 'installing'
    if (this.errors.has(m.id) && !installed) installState = 'error'

    // 실행 상태: 관리 중인 프로세스가 살아있거나, 대시보드 포트가 열려있으면 running.
    const managed = this.managed.get(m.id)
    const managedAlive = !!managed && managed.child.exitCode === null && !managed.child.killed
    let portOpen = false
    if (m.dashboard?.port) portOpen = await isPortOpen(m.dashboard.port)

    let runState: RunState = 'stopped'
    if (this.starting.has(m.id)) runState = 'starting'
    else if (managedAlive || portOpen) runState = 'running'

    const view: AppView = {
      manifest: m,
      installState,
      runState,
      dir: installed ? dir : undefined,
      portOpen,
      pid: managedAlive ? managed!.child.pid : undefined,
      lastError: this.errors.get(m.id)
    }

    if (installed) {
      view.git = await gitInfo(dir, this.shell())
      view.version = readVersion(dir)
    }
    return view
  }

  // ---- 설치 ----

  async install(id: string): Promise<AppView> {
    const m = mustManifest(id)
    const settings = this.deps.getSettings()
    const { dir, installed } = resolveDir(m, settings)
    if (installed) {
      // 이미 있음 — 설치 스텝만(멱등한 경우) 재실행하지 않고 그대로 반환.
      return this.buildView(m)
    }
    this.errors.delete(id)
    this.installBusy.add(id)
    this.deps.emitState()
    try {
      // 1) clone (없을 때만)
      if (!existsSync(dir)) {
        this.progress({ appId: id, phase: 'clone', status: 'begin', message: `clone → ${dir}` })
        let code = await clone(m.repo, dir, (line, level) => this.log(id, 'install', line, level), this.shell())
        if (code !== 0 && m.repo.startsWith('git@')) {
          // ssh 실패 → https 폴백
          const https = toHttps(m.repo)
          this.log(id, 'install', `ssh clone 실패 — https 폴백: ${https}`, 'error')
          code = await clone(https, dir, (line, level) => this.log(id, 'install', line, level), this.shell())
        }
        if (code !== 0) throw new Error('git clone 실패 (권한/네트워크 확인)')
      }
      // 2) install steps
      const steps = m.install ?? []
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]
        this.progress({
          appId: id,
          phase: 'install',
          status: 'step',
          message: s.run,
          stepIndex: i + 1,
          stepTotal: steps.length
        })
        this.log(id, 'install', `$ ${s.run}`)
        const cwd = s.cwd ? join(dir, s.cwd) : dir
        const code = await runStreaming(s.run, cwd, (line, level) => this.log(id, 'install', line, level), this.shell())
        if (code !== 0) throw new Error(`설치 스텝 실패: ${s.run} (exit ${code})`)
      }
      this.progress({ appId: id, phase: 'install', status: 'done', message: '설치 완료' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.errors.set(id, msg)
      this.progress({ appId: id, phase: 'install', status: 'error', message: msg })
      this.log(id, 'install', msg, 'error')
    } finally {
      this.installBusy.delete(id)
      this.deps.emitState()
    }
    return this.buildView(m)
  }

  // ---- 업데이트 ----

  async update(id: string): Promise<AppView> {
    const m = mustManifest(id)
    const { dir, installed } = resolveDir(m, this.deps.getSettings())
    if (!installed) throw new Error('설치되지 않음')
    this.errors.delete(id)
    const steps = m.update ?? [{ run: 'git pull --ff-only' }]
    this.progress({ appId: id, phase: 'update', status: 'begin', message: '업데이트 시작' })
    try {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]
        this.progress({
          appId: id,
          phase: 'update',
          status: 'step',
          message: s.run,
          stepIndex: i + 1,
          stepTotal: steps.length
        })
        this.log(id, 'update', `$ ${s.run}`)
        const cwd = s.cwd ? join(dir, s.cwd) : dir
        const code = await runStreaming(s.run, cwd, (line, level) => this.log(id, 'update', line, level), this.shell())
        if (code !== 0) throw new Error(`업데이트 스텝 실패: ${s.run} (exit ${code})`)
      }
      this.progress({ appId: id, phase: 'update', status: 'done', message: '업데이트 완료' })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.errors.set(id, msg)
      this.progress({ appId: id, phase: 'update', status: 'error', message: msg })
      this.log(id, 'update', msg, 'error')
    } finally {
      this.deps.emitState()
    }
    return this.buildView(m)
  }

  async checkUpdate(id: string): Promise<AppView> {
    const m = mustManifest(id)
    const { dir, installed } = resolveDir(m, this.deps.getSettings())
    if (installed) await fetchAndCompare(dir, this.shell())
    this.deps.emitState()
    return this.buildView(m)
  }

  // ---- 시작 / 정지 ----

  async start(id: string): Promise<AppView> {
    const m = mustManifest(id)
    const { dir, installed } = resolveDir(m, this.deps.getSettings())
    if (!installed) throw new Error('먼저 설치하세요')
    if (!m.start) throw new Error('start 명령이 없습니다')

    if (m.launchMode !== 'process') {
      // cmux / manual — 직접 spawn 하지 않고 위임
      return this.openInCmux(id).then(() => this.buildView(m))
    }

    if (this.managed.has(id)) return this.buildView(m) // 이미 실행중
    this.errors.delete(id)
    this.starting.add(id)
    this.progress({ appId: id, phase: 'start', status: 'begin', message: m.start.run })
    this.log(id, 'run', `$ ${m.start.run}`)
    this.deps.emitState()

    const cwd = m.start.cwd ? join(dir, m.start.cwd) : dir
    const child = spawnLongRunning(
      m.start.run,
      cwd,
      (line, level) => this.log(id, 'run', line, level),
      this.shell()
    )
    this.managed.set(id, { child, dir })
    child.on('close', (code) => {
      this.managed.delete(id)
      this.starting.delete(id)
      if (code && code !== 0 && code !== 143 /* SIGTERM */) {
        this.errors.set(id, `프로세스 종료 (exit ${code})`)
        this.log(id, 'run', `프로세스 종료 (exit ${code})`, 'error')
      } else {
        this.log(id, 'run', '프로세스 종료')
      }
      this.deps.emitState()
    })

    // 포트가 뜰 때까지 잠깐 폴링 → running 확정
    if (m.dashboard?.port) {
      void this.waitForPort(id, m.dashboard.port)
    } else {
      setTimeout(() => {
        this.starting.delete(id)
        this.deps.emitState()
      }, 1500)
    }
    this.deps.emitState()
    return this.buildView(m)
  }

  private async waitForPort(id: string, port: number): Promise<void> {
    for (let i = 0; i < 30; i++) {
      if (!this.managed.has(id)) break // 도중 종료
      if (await isPortOpen(port)) {
        this.starting.delete(id)
        this.progress({ appId: id, phase: 'start', status: 'done', message: '실행 중' })
        this.deps.emitState()
        return
      }
      await delay(500)
    }
    this.starting.delete(id)
    this.deps.emitState()
  }

  async stop(id: string): Promise<AppView> {
    const m = mustManifest(id)
    const managed = this.managed.get(id)
    if (managed) {
      this.progress({ appId: id, phase: 'stop', status: 'begin', message: '정지' })
      killGroup(managed.child)
      this.managed.delete(id)
      this.log(id, 'run', '정지 요청됨')
      this.deps.emitState()
      return this.buildView(m)
    }
    // palace 가 관리하지 않는(예: cmux 에서 켠) 프로세스
    throw new Error('palace 가 시작한 프로세스가 아닙니다 — 실행한 cmux 탭/터미널에서 종료하세요')
  }

  /**
   * cmux/manual 앱 기동 위임. cmux CLI 가 있으면 `new-workspace --cwd --command` 로
   * 새 워크스페이스에서 바로 실행(cmuxOnly 제약 충족). 없으면 클립보드 폴백.
   */
  async openInCmux(id: string): Promise<{ ok: boolean; message: string }> {
    const m = mustManifest(id)
    const { dir, installed } = resolveDir(m, this.deps.getSettings())
    if (!installed) return { ok: false, message: '먼저 설치하세요' }
    const startCmd = m.start?.run ?? ''

    // cmux 바이너리 찾기: PATH → 앱 번들 경로
    const cmuxBin = await this.findCmux()
    if (cmuxBin) {
      this.log(id, 'run', `$ cmux new-workspace --cwd ${dir} --command ${JSON.stringify(startCmd)}`)
      const res = await runCapture(
        `${shellQuote(cmuxBin)} new-workspace --cwd ${shellQuote(dir)} --command ${shellQuote(startCmd)}`,
        undefined,
        this.shell(),
        15_000
      )
      if (res.code === 0) {
        setTimeout(() => this.deps.emitState(), 1500)
        return { ok: true, message: `cmux 새 워크스페이스에서 실행했어요 — ${startCmd}` }
      }
      this.log(id, 'run', res.stderr.trim() || 'cmux 실행 실패', 'error')
    }

    // 폴백: 클립보드 + cmux 열기
    clipboard.writeText(`cd ${shellQuote(dir)} && ${startCmd}`)
    await runCapture('open -a cmux 2>/dev/null || true', undefined, this.shell(), 5000)
    return {
      ok: true,
      message: 'cmux CLI 자동실행이 안 돼 명령을 클립보드에 복사했어요. cmux 새 탭에서 ⌘V.'
    }
  }

  private async findCmux(): Promise<string | null> {
    const res = await runCapture(
      'command -v cmux || (test -x "/Applications/cmux.app/Contents/Resources/bin/cmux" && echo "/Applications/cmux.app/Contents/Resources/bin/cmux")',
      undefined,
      this.shell(),
      5000
    )
    const p = res.stdout.trim().split('\n')[0]
    return p && res.code === 0 ? p : null
  }

  // ---- 닥터 ----

  async doctor(id: string): Promise<PrereqResult[]> {
    const m = mustManifest(id)
    const reqs = m.prerequisites ?? []
    return Promise.all(reqs.map((r) => this.checkOne(r)))
  }

  private async checkOne(r: NonNullable<Manifest['prerequisites']>[number]): Promise<PrereqResult> {
    const res = await runCapture(r.check, undefined, this.shell(), 15_000)
    const ok = res.code === 0
    return {
      name: r.name,
      ok,
      install: r.install,
      optional: r.optional,
      manual: r.manual,
      note: r.note,
      detail: ok ? res.stdout.trim().split('\n')[0] : res.stderr.trim().split('\n')[0] || '미설치'
    }
  }

  /** 전제 도구 하나를 palace 가 직접 설치(자동 가능한 것만). 로그는 'doctor' 스트림. */
  async installPrereq(id: string, name: string): Promise<PrereqResult> {
    const m = mustManifest(id)
    const r = (m.prerequisites ?? []).find((x) => x.name === name)
    if (!r) throw new Error(`알 수 없는 전제 도구: ${name}`)
    if (!r.install) throw new Error(`${name}: 설치 명령이 없습니다`)
    if (r.manual) throw new Error(`${name}: 자동 설치 불가 — ${r.note ?? '수동 설치가 필요합니다'}`)
    this.progress({ appId: id, phase: 'install', status: 'step', message: `${name} 설치` })
    this.log(id, 'doctor', `$ ${r.install}`)
    const code = await runStreaming(r.install, undefined, (line, level) => this.log(id, 'doctor', line, level), this.shell())
    if (code !== 0) this.log(id, 'doctor', `${name} 설치 실패 (exit ${code})`, 'error')
    const result = await this.checkOne(r)
    this.deps.emitState()
    return result
  }

  /** 누락된 자동설치 가능한 전제 도구를 순서대로 설치. */
  async installAllPrereqs(id: string): Promise<PrereqResult[]> {
    const m = mustManifest(id)
    const reqs = m.prerequisites ?? []
    const out: PrereqResult[] = []
    for (const r of reqs) {
      const cur = await this.checkOne(r)
      if (cur.ok || r.manual || !r.install) {
        out.push(cur)
        continue
      }
      out.push(await this.installPrereq(id, r.name))
    }
    return out
  }

  // ---- 문서 ----

  async readDocs(id: string, path?: string): Promise<{ path: string; html: string } | null> {
    const m = mustManifest(id)
    const { dir, installed } = resolveDir(m, this.deps.getSettings())
    if (!installed) return null
    const rel = path ?? m.readme ?? 'README.md'
    const abs = join(dir, rel)
    if (!existsSync(abs)) return null
    const md = readFileSync(abs, 'utf8')
    return { path: rel, html: renderMarkdown(md, m.repoHttps) }
  }

  // ---- 환경변수 ----

  async readEnv(id: string): Promise<EnvView | null> {
    const m = mustManifest(id)
    if (!m.env) return null
    const { dir, installed } = resolveDir(m, this.deps.getSettings())
    if (!installed) return null
    const file = join(dir, m.env.file)
    const example = m.env.example ? join(dir, m.env.example) : undefined
    return {
      path: m.env.file,
      exists: existsSync(file),
      hasExample: !!example && existsSync(example),
      entries: parseEnv(existsSync(file) ? file : example ?? file, m.env.secretKeys)
    }
  }

  async writeEnvFile(id: string, entries: EnvEntry[]): Promise<EnvView | null> {
    const m = mustManifest(id)
    if (!m.env) return null
    const { dir, installed } = resolveDir(m, this.deps.getSettings())
    if (!installed) return null
    writeEnvFile(join(dir, m.env.file), entries)
    this.log(id, 'run', `${m.env.file} 저장됨 (${entries.length} keys)`)
    return this.readEnv(id)
  }

  async seedEnvFromExample(id: string): Promise<EnvView | null> {
    const m = mustManifest(id)
    if (!m.env?.example) return this.readEnv(id)
    const { dir, installed } = resolveDir(m, this.deps.getSettings())
    if (!installed) return null
    const file = join(dir, m.env.file)
    const example = join(dir, m.env.example)
    if (!existsSync(file) && existsSync(example)) {
      copyFileSync(example, file)
      this.log(id, 'run', `${m.env.example} → ${m.env.file} 시드`)
    }
    return this.readEnv(id)
  }

  // ---- 정리 ----

  killAll(): void {
    for (const { child } of this.managed.values()) killGroup(child)
    this.managed.clear()
  }
}

function readVersion(dir: string): string | undefined {
  try {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      const j = JSON.parse(readFileSync(pkg, 'utf8'))
      if (j.version) return String(j.version)
    }
  } catch {
    /* noop */
  }
  return undefined
}

function mustManifest(id: string): Manifest {
  const m = loadManifests().find((x) => x.id === id)
  if (!m) throw new Error(`알 수 없는 앱: ${id}`)
  return m
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// isGitRepo 재노출(사용 안 하지만 트리셰이킹 방지용 참조 회피)
void isGitRepo
