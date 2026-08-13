import { existsSync, readFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipboard } from 'electron'
import type { ChildProcess } from 'node:child_process'
import type {
  AppView,
  ChangesView,
  EnvEntry,
  EnvView,
  InstallState,
  KeepAwakeView,
  LogLine,
  Manifest,
  OnboardingKey,
  OnboardingState,
  PrereqResult,
  ProgressEvent,
  RunState,
  Settings,
  Step
} from '../shared/types'
import { parseEnv, writeEnv as writeEnvFile } from './env'
import { computeOnboarding, openInTerminal } from './onboarding'
import { loadManifests, resolveDir } from './registry'
import { fetchAndCompare, gitInfo, clone, toHttps, isGitRepo, ensureUpstream, clearStaleIndexLock } from './git'
import { runCapture, runStreaming, spawnLongRunning, killGroup } from './exec'
import { isPortOpen } from './health'
import { isOnBatteryPower, syncKeepAwake } from './keepAwake'
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

  /**
   * install/update 스텝 하나를 실행하며 로그를 흘린다.
   * 실패했을 때 "(exit 1)" 만 보여주면 원인을 알 수 없어서, 첫 에러 줄(대개 git 이 뱉는
   * 진짜 원인)을 같이 돌려준다 — 카드에 뜨는 실패 메시지에 그대로 붙인다.
   */
  private async runStep(
    id: string,
    phase: 'install' | 'update',
    s: Step,
    dir: string
  ): Promise<{ code: number; reason: string }> {
    const cwd = s.cwd ? join(dir, s.cwd) : dir
    let reason = ''
    const code = await runStreaming(
      s.run,
      cwd,
      (line, level) => {
        if (level === 'error' && !reason && line.trim()) reason = line.trim()
        this.log(id, phase, line, level)
      },
      this.shell()
    )
    return { code, reason }
  }

  private static stepError(phase: '설치' | '업데이트', s: Step, code: number, reason: string): Error {
    return new Error(`${phase} 스텝 실패: ${s.run} (exit ${code})${reason ? ` — ${reason}` : ''}`)
  }

  // ---- 상태 계산 ----

  async listApps(): Promise<AppView[]> {
    const manifests = loadManifests()
    const views = await Promise.all(manifests.map((m) => this.buildView(m)))
    // 상태를 다시 셀 때마다 어서션도 맞춘다. 앱이 뜨고 지는 모든 경로(IPC·주기 폴링)가
    // 여기를 지나므로, 슬립 차단은 별도 트리거 없이 실행 상태를 그대로 따라간다.
    syncKeepAwake(views.filter((v) => v.keepAwake?.active).map((v) => v.manifest.id))
    return views
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
      keepAwake: m.start || m.dashboard ? keepAwakeView(m, settings, runState) : undefined,
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
      // clone 직후/기존 repo 모두 upstream 보장 → 이후 update 의 git pull 이 항상 성립
      if (isGitRepo(dir)) await ensureUpstream(dir, this.shell())
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
        const { code, reason } = await this.runStep(id, 'install', s, dir)
        if (code !== 0) throw AppManager.stepError('설치', s, code, reason)
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
      // git repo 면 upstream 자가치유(추적 브랜치 미설정 시 origin/<branch> 로) →
      // "no tracking information" 으로 `git pull --ff-only` 가 실패하는 걸 막는다.
      // 죽은 index.lock 도 같이 치운다 — 남아있으면 pull 이 계속 exit 1.
      if (isGitRepo(dir)) {
        if (await clearStaleIndexLock(dir, this.shell()))
          this.log(id, 'update', '죽은 .git/index.lock 을 정리했습니다', 'error')
        await ensureUpstream(dir, this.shell())
      }
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
        const { code, reason } = await this.runStep(id, 'update', s, dir)
        if (code !== 0) throw AppManager.stepError('업데이트', s, code, reason)
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
    const child = await spawnLongRunning(
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
      this.errors.delete(id)
      this.starting.add(id)
      this.progress({ appId: id, phase: 'start', status: 'begin', message: startCmd })
      this.deps.emitState()
      try {
        // `new-workspace` 는 "caller's window" 에 워크스페이스를 만드는 명령이라 cmux 앱이
        // 이미 떠 있어야 동작한다(`cmux <path>` 와 달리 스스로 앱을 안 띄움). 안 떠 있으면
        // 먼저 실행하고 소켓이 응답할 때까지 기다린 뒤 위임한다.
        const ready = await this.ensureCmuxRunning(cmuxBin, id)
        if (ready) {
          this.log(id, 'run', `$ cmux new-workspace --cwd ${dir} --command ${JSON.stringify(startCmd)}`)
          const res = await runCapture(
            `CMUX_QUIET=1 ${shellQuote(cmuxBin)} new-workspace --cwd ${shellQuote(dir)} --command ${shellQuote(startCmd)}`,
            undefined,
            this.shell(),
            15_000
          )
          if (res.code === 0) {
            return await this.confirmDelegated(id, m, cmuxBin, res.stdout, startCmd)
          }
          this.log(id, 'run', res.stderr.trim() || 'cmux 실행 실패', 'error')
        } else {
          this.log(id, 'run', 'cmux 앱이 준비되지 않아(소켓 미응답) 위임을 건너뜁니다', 'error')
        }
      } finally {
        this.starting.delete(id)
        this.deps.emitState()
      }
    }

    // 폴백: 클립보드 + cmux 열기
    clipboard.writeText(`cd ${shellQuote(dir)} && ${startCmd}`)
    await runCapture('open -a cmux 2>/dev/null || true', undefined, this.shell(), 5000)
    return {
      ok: true,
      message: 'cmux CLI 자동실행이 안 돼 명령을 클립보드에 복사했어요. cmux 새 탭에서 ⌘V.'
    }
  }

  /**
   * 위임의 성공은 "cmux 가 명령을 받았다"까지만 뜻한다. 새 워크스페이스 안에서 서버가
   * 즉사하면(포트를 다른 인스턴스가 물고 있는 경우가 대표적) palace 는 성공 토스트를 띄우고
   * 앱은 계속 "정지" — 눌러도 아무 일도 안 일어난 것처럼 보인다. 그래서 대시보드 포트가
   * 실제로 열리는지까지 확인하고, 안 열리면 그 워크스페이스 화면 끝을 실패 사유로 돌려준다.
   */
  private async confirmDelegated(
    id: string,
    m: Manifest,
    cmuxBin: string,
    newWorkspaceOut: string,
    startCmd: string
  ): Promise<{ ok: boolean; message: string }> {
    const port = m.dashboard?.port
    if (!port) {
      // 확인할 포트가 없는 도구 — 명령을 넘긴 것까지가 우리가 아는 전부.
      this.progress({ appId: id, phase: 'start', status: 'done', message: '위임 완료' })
      setTimeout(() => this.deps.emitState(), 1500)
      return { ok: true, message: `cmux 새 워크스페이스에서 실행했어요 — ${startCmd}` }
    }

    for (let i = 0; i < 60; i++) {
      if (await isPortOpen(port)) {
        this.progress({ appId: id, phase: 'start', status: 'done', message: '실행 중' })
        this.deps.emitState()
        return { ok: true, message: `cmux 워크스페이스에서 실행 중 — 포트 ${port}` }
      }
      await delay(500)
    }

    const ws = newWorkspaceOut.match(/workspace:\d+/)?.[0]
    const tail = ws ? await this.readWorkspaceTail(cmuxBin, ws) : ''
    if (tail) this.log(id, 'run', tail, 'error')
    const why = tail ? firstMeaningfulLine(tail) : ''
    const msg = `${startCmd} 를 넘겼지만 포트 ${port} 가 안 열렸어요${why ? ` — ${why}` : ' — 그 cmux 워크스페이스 화면을 확인하세요'}`
    this.errors.set(id, msg)
    this.progress({ appId: id, phase: 'start', status: 'error', message: msg })
    return { ok: false, message: msg }
  }

  /** 위임한 워크스페이스의 화면 끝부분 — 실패 사유(EADDRINUSE 등)가 여기 찍힌다. */
  private async readWorkspaceTail(cmuxBin: string, workspaceRef: string): Promise<string> {
    const res = await runCapture(
      `CMUX_QUIET=1 ${shellQuote(cmuxBin)} read-screen --workspace ${shellQuote(workspaceRef)} --lines 40`,
      undefined,
      this.shell(),
      8000
    )
    if (res.code !== 0) return ''
    return res.stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim())
      .slice(-8)
      .join('\n')
  }

  /** cmux 소켓이 응답하는지 확인하고, 안 떠 있으면 실행해 준비될 때까지 폴링(최대 ~15s). */
  private async ensureCmuxRunning(cmuxBin: string, id?: string): Promise<boolean> {
    if (await this.cmuxAlive(cmuxBin)) return true
    if (id) this.log(id, 'run', 'cmux 앱이 안 떠 있어 먼저 실행합니다…')
    await runCapture('open -a cmux 2>/dev/null || true', undefined, this.shell(), 5000)
    // 프로브가 타임아웃까지 가면 한 번에 5s 가 날아간다 — 반복 횟수가 아니라 마감시간으로 끊는다.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await delay(500)
      if (await this.cmuxAlive(cmuxBin)) return true
    }
    return false
  }

  /** read-only probe: cmux 소켓이 살아있으면 exit 0. */
  private async cmuxAlive(cmuxBin: string): Promise<boolean> {
    const res = await runCapture(
      `CMUX_QUIET=1 ${shellQuote(cmuxBin)} list-workspaces`,
      undefined,
      this.shell(),
      5000
    )
    return res.code === 0
  }

  /**
   * 도구의 OS 자동시작 배선(매니페스트 autostart)을 멱등 실행. 이미 배선돼 있으면 no-op.
   * 이미 다 깔린 컴퓨터에서 "설치/업데이트" 없이도 훅/supervisor 를 걸 수 있는 단일 경로.
   */
  async ensureAutostart(id: string): Promise<{ ok: boolean; message: string }> {
    const m = mustManifest(id)
    if (!m.autostart) return { ok: true, message: '이 도구는 자동시작 배선이 없어요' }
    const { dir, installed } = resolveDir(m, this.deps.getSettings())
    if (!installed) return { ok: false, message: '먼저 설치하세요' }
    const cwd = m.autostart.cwd ? join(dir, m.autostart.cwd) : dir
    const res = await runCapture(m.autostart.run, cwd, this.shell(), 20_000)
    const out = (res.stdout + res.stderr).trim()
    if (out) this.log(id, 'autostart', out, res.code === 0 ? 'info' : 'error')
    if (res.code === 0) return { ok: true, message: '자동시작 배선 완료' }
    return { ok: false, message: out || '자동시작 배선 실패' }
  }

  /** 설치된 도구 전체의 자동시작을 배선(palace 시작 시 호출). 실패해도 조용히 넘어간다. */
  async wireAllAutostart(): Promise<void> {
    for (const m of loadManifests()) {
      if (!m.autostart) continue
      const { installed } = resolveDir(m, this.deps.getSettings())
      if (!installed) continue
      await this.ensureAutostart(m.id).catch(() => undefined)
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

  // ---- 변경사항(git diff) ----

  async getChanges(id: string): Promise<ChangesView | null> {
    const m = mustManifest(id)
    const { dir, installed } = resolveDir(m, this.deps.getSettings())
    if (!installed) return null
    const sh = this.shell()
    await runCapture('git fetch --quiet', dir, sh, 90_000)
    const [branch, counts, status, incoming, outgoing, diffStat, diff] = await Promise.all([
      runCapture('git rev-parse --abbrev-ref HEAD', dir, sh),
      runCapture('git rev-list --left-right --count @{u}...HEAD 2>/dev/null', dir, sh),
      runCapture('git status --short', dir, sh),
      runCapture('git log --oneline --no-decorate HEAD..@{u} 2>/dev/null | head -50', dir, sh),
      runCapture('git log --oneline --no-decorate @{u}..HEAD 2>/dev/null | head -50', dir, sh),
      runCapture('git diff --stat HEAD..@{u} 2>/dev/null', dir, sh),
      runCapture('git diff HEAD..@{u} 2>/dev/null', dir, sh)
    ])
    const cm = counts.stdout.trim().match(/^(\d+)\s+(\d+)$/)
    const behind = cm ? Number(cm[1]) : 0
    const ahead = cm ? Number(cm[2]) : 0
    const dirty = status.stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => ({ status: l.slice(0, 2).trim(), file: l.slice(3) }))
    const CAP = 24_000
    const rawDiff = diff.stdout
    const truncated = rawDiff.length > CAP
    return {
      branch: branch.stdout.trim() || undefined,
      behind,
      ahead,
      dirty,
      incoming: parseLog(incoming.stdout),
      outgoing: parseLog(outgoing.stdout),
      diffStat: diffStat.stdout.trim(),
      diff: truncated ? rawDiff.slice(0, CAP) : rawDiff,
      diffTruncated: truncated,
      clean: behind === 0 && ahead === 0 && dirty.length === 0
    }
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

  // ---- 온보딩 ----

  async getOnboarding(): Promise<OnboardingState> {
    return computeOnboarding(this.deps.getSettings())
  }

  async onboardingAction(key: OnboardingKey): Promise<{ ok: boolean; message: string }> {
    const shell = this.shell()
    switch (key) {
      case 'github':
        await openInTerminal('command -v gh >/dev/null 2>&1 || brew install gh; gh auth login', shell)
        return { ok: true, message: '터미널에서 GitHub 로그인을 진행하세요. 끝나면 “다시 확인”.' }
      case 'tailscale':
        await openInTerminal(
          'command -v tailscale >/dev/null 2>&1 || brew install --cask tailscale; open -a Tailscale',
          shell
        )
        return { ok: true, message: 'Tailscale 앱에서 로그인하세요. 끝나면 “다시 확인”.' }
      case 'dotfiles':
        await this.install('dotfiles')
        return { ok: true, message: 'dotfiles 설치를 시작했어요 — 로그 탭에서 진행을 볼 수 있어요.' }
      case 'tools':
        return { ok: true, message: '카탈로그에서 각 도구를 설치하세요.' }
      default:
        return { ok: false, message: '알 수 없는 단계' }
    }
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

function parseLog(out: string): { sha: string; subject: string }[] {
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const sp = l.indexOf(' ')
      return sp > 0 ? { sha: l.slice(0, sp), subject: l.slice(sp + 1) } : { sha: l, subject: '' }
    })
}

/** 화면 끝부분에서 토스트에 쓸 한 줄 — 에러처럼 보이는 줄이 있으면 그걸, 없으면 마지막 줄. */
function firstMeaningfulLine(tail: string): string {
  const lines = tail.split('\n').filter((l) => l.trim())
  const err = lines.find((l) => /error|EADDRINUSE|not found|failed|권한|실패/i.test(l))
  const pick = (err ?? lines[lines.length - 1] ?? '').trim()
  return pick.length > 140 ? `${pick.slice(0, 140)}…` : pick
}

/**
 * 앱별 '항상 깨어있기' 상태. 사용자가 앱별로 정한 값이 우선, 없으면 매니페스트 기본값.
 * 켜둔 것과 실제로 막고 있는 것은 다르다 — 앱이 정지 중이거나 배터리면 켜져 있어도 안 잡는다.
 */
function keepAwakeView(m: Manifest, settings: Settings, runState: RunState): KeepAwakeView {
  const enabled = settings.keepAwake?.[m.id] ?? m.keepAwake ?? false
  const idleReason = !enabled
    ? 'off'
    : runState !== 'running'
      ? 'not-running'
      : isOnBatteryPower()
        ? 'on-battery'
        : undefined
  return { enabled, active: !idleReason, idleReason }
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
