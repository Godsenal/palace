// palace — 공유 타입. main / preload / renderer 가 이 계약을 공유한다.

/** 앱을 어떻게 기동하는가. */
export type LaunchMode =
  | 'process' // palace 가 직접 자식 프로세스로 spawn (로그·정지 관리)
  | 'cmux' // cmux 터미널/탭에서 실행되어야 함 → 명령 위임(복사 / cmux 열기)
  | 'manual' // 사용자가 직접. palace 는 명령만 안내

/** 하나의 셸 스텝. cwd 는 앱 디렉토리 기준 상대경로(기본 '.'). */
export interface Step {
  run: string
  cwd?: string
}

export interface Prerequisite {
  name: string
  /** 성공(exit 0)이면 설치된 것으로 간주하는 점검 명령. */
  check: string
  /** 누락 시 실행/안내할 설치 명령. */
  install?: string
  /** 없어도 되는 선택 도구면 true. */
  optional?: boolean
  /**
   * true 면 palace 가 자동 실행하지 않는다(관리자 암호·GUI·계정 로그인 등 사람 손 필요).
   * 이 경우 UI 는 명령 복사 + note 안내만 한다.
   */
  manual?: boolean
  /** manual 도구에 대한 안내(왜 수동인지). */
  note?: string
}

export interface DashboardSpec {
  /** 임베드/열기 대상 URL. */
  url: string
  /** 헬스체크용 포트(있으면 실행중 판정에 사용). */
  port?: number
}

/** 앱 정의(매니페스트). 내장 레지스트리 + 사용자 추가(~/.palace/apps/*.json). */
export interface Manifest {
  id: string
  name: string
  tagline: string
  /** 자세한 설명(선택). */
  description?: string
  /** git clone 용 (ssh 또는 https). */
  repo: string
  /** 브라우저에서 열 저장소 페이지. */
  repoHttps?: string
  runtime?: 'bun' | 'node' | 'other'
  /** 이미 clone 되어 있을 수 있는 절대경로 후보(~ 확장). 감지되면 재clone 안 함. */
  detectPaths?: string[]
  prerequisites?: Prerequisite[]
  /** clone 후 1회 실행하는 설치 스텝. */
  install?: Step[]
  /** 업데이트 시 실행(기본: git pull). */
  update?: Step[]
  launchMode: LaunchMode
  /** launchMode 가 process 일 때 spawn 할 명령. cmux/manual 일 때는 안내로 표시. */
  start?: Step
  /**
   * 이 도구의 OS 수준 자동시작을 배선하는 **멱등** 명령(예: ~/.zshrc 훅, launchd supervisor).
   * palace 가 실행 시(설정 autoWireTools) 또는 버튼으로 돌린다. 이미 배선돼 있으면 no-op 이어야 한다.
   */
  autostart?: Step
  dashboard?: DashboardSpec
  /** 앱 디렉토리 기준 README 경로. */
  readme?: string
  /** 추가로 렌더할 문서 경로들(예: CLAUDE.md). */
  extraDocs?: string[]
  notes?: string
  /** 앱이 읽는 env 파일 편집 지원(있을 때만 '환경' 탭 노출). */
  env?: EnvSpec
  /** 내장 매니페스트는 true. */
  builtin?: boolean
  /** UI 강조색(옵션). */
  accent?: string
}

export interface EnvSpec {
  /** 앱 디렉토리 기준 env 파일 경로(예: loops.env, .env). */
  file: string
  /** 없을 때 시드로 복사할 예시 파일(예: loops.env.example). */
  example?: string
  /** 비밀값으로 마스킹할 키(정규식 문자열). 기본 휴리스틱에 추가. */
  secretKeys?: string[]
}

export interface EnvEntry {
  key: string
  value: string
  secret: boolean
}

export interface EnvView {
  path: string
  exists: boolean
  hasExample: boolean
  entries: EnvEntry[]
}

export type InstallState = 'not-installed' | 'installing' | 'installed' | 'error'
export type RunState = 'stopped' | 'starting' | 'running' | 'error'

export interface GitInfo {
  branch?: string
  shortSha?: string
  dirty?: boolean
  /** origin 대비 뒤처진 커밋 수(fetch 후). */
  behind?: number
  ahead?: number
  updateAvailable?: boolean
}

/** 렌더러에 내려가는, 매니페스트 + 라이브 상태 합본. */
export interface AppView {
  manifest: Manifest
  installState: InstallState
  runState: RunState
  /** 설치 경로(설치됐다면). */
  dir?: string
  /** 헬스체크로 대시보드 포트가 열려있는지. */
  portOpen?: boolean
  /** palace 가 관리 중인 자식 프로세스 pid(있다면). */
  pid?: number
  git?: GitInfo
  version?: string
  lastError?: string
}

export interface ChangeFile {
  status: string
  file: string
}
export interface ChangeCommit {
  sha: string
  subject: string
}
/** git 변경 요약(로컬 uncommitted + 원격 대비). '변경' 탭용. */
export interface ChangesView {
  branch?: string
  behind: number
  ahead: number
  dirty: ChangeFile[]
  incoming: ChangeCommit[]
  outgoing: ChangeCommit[]
  diffStat: string
  /** 원격에서 들어올 통합 diff(길면 잘림). */
  diff: string
  diffTruncated: boolean
  clean: boolean
}

export interface PrereqResult {
  name: string
  ok: boolean
  detail?: string
  install?: string
  optional?: boolean
  manual?: boolean
  note?: string
}

export interface Settings {
  /** 새 앱을 clone 할 루트. 기본 ~/LTH. */
  installRoot: string
  /** 로그인 셸(명령 실행 시 PATH 확보용). 기본 자동감지. */
  shell?: string
  theme?: 'dark' | 'light'
  /** 온보딩을 닫았는지(닫으면 자동 표시 안 함, 버튼으로 언제든 다시 열 수 있음). */
  onboardingDismissed?: boolean
  /**
   * 로그인 시 palace(+cmux)를 자동 실행하도록 로그인 항목에 등록할지. 기본 true.
   * false 로 두면 palace 가 로그인 항목을 건드리지 않는다(사용자가 직접 관리).
   */
  launchAtLogin?: boolean
  /**
   * palace 실행 시 설치된 도구들의 자동시작(매니페스트 autostart)을 자동 배선할지. 기본 true.
   * 이미 다 깔린 컴퓨터도 palace 만 켜면 훅/supervisor 가 걸린다. 멱등이라 반복 안전.
   */
  autoWireTools?: boolean
}

// ---- 온보딩(새 컴퓨터 셋업 체크리스트) ----

export type OnboardingKey = 'github' | 'tailscale' | 'dotfiles' | 'tools'

export interface OnboardingStep {
  key: OnboardingKey
  title: string
  hint: string
  ok: boolean
  detail?: string
  /** 진행 표시(예: '2/2'). */
  progress?: string
  /** 이 단계에 palace 가 실행할 수 있는 액션이 있는가. */
  actionable: boolean
  actionLabel?: string
}

export interface OnboardingState {
  steps: OnboardingStep[]
  allDone: boolean
  dismissed: boolean
}

// ---- IPC 이벤트 페이로드 ----

export interface LogLine {
  appId: string
  /** 'install' | 'update' | 'run' 등 스트림 구분. */
  stream: string
  line: string
  level?: 'info' | 'error'
  ts: number
}

export interface ProgressEvent {
  appId: string
  phase: 'install' | 'update' | 'start' | 'stop' | 'clone'
  status: 'begin' | 'step' | 'done' | 'error'
  message: string
  stepIndex?: number
  stepTotal?: number
}

/** preload 가 노출하는 API 표면. window.palace */
export interface PalaceAPI {
  listApps(): Promise<AppView[]>
  getApp(id: string): Promise<AppView | null>
  refresh(id?: string): Promise<AppView[]>
  install(id: string): Promise<AppView>
  update(id: string): Promise<AppView>
  checkUpdate(id: string): Promise<AppView>
  start(id: string): Promise<AppView>
  stop(id: string): Promise<AppView>
  openInCmux(id: string): Promise<{ ok: boolean; message: string }>
  ensureAutostart(id: string): Promise<{ ok: boolean; message: string }>
  runDoctor(id: string): Promise<PrereqResult[]>
  installPrereq(id: string, name: string): Promise<PrereqResult>
  installAllPrereqs(id: string): Promise<PrereqResult[]>
  readDocs(id: string, path?: string): Promise<{ path: string; html: string } | null>
  getChanges(id: string): Promise<ChangesView | null>
  readEnv(id: string): Promise<EnvView | null>
  writeEnv(id: string, entries: EnvEntry[]): Promise<EnvView | null>
  seedEnvFromExample(id: string): Promise<EnvView | null>
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  addManifest(m: Manifest): Promise<AppView[]>
  removeManifest(id: string): Promise<AppView[]>
  getOnboarding(): Promise<OnboardingState>
  onboardingAction(key: OnboardingKey): Promise<{ ok: boolean; message: string }>
  dismissOnboarding(): Promise<void>
  openExternal(url: string): Promise<void>
  openDir(id: string): Promise<void>
  writeClipboard(text: string): Promise<void>
  // 이벤트 구독 (해제 함수 반환)
  onLog(cb: (l: LogLine) => void): () => void
  onProgress(cb: (p: ProgressEvent) => void): () => void
  onStateChanged(cb: (apps: AppView[]) => void): () => void
  // 허브 자체 업데이트
  checkForHubUpdate(): Promise<{ available: boolean; version?: string; error?: string }>
}
