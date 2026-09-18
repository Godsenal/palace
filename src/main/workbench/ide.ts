import { execFile as execFileCallback } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { spawn as spawnPty, type IPty } from 'node-pty'
import type { MachineSettings, PortableProfile } from '../../shared/automation'
import type {
  AgentProfile,
  AgentQuestion,
  AgentSession,
  IDEAPI,
  SessionDetail,
  SessionEvent,
  WorkbenchSnapshot,
  Workspace,
  WorkspaceChanges
} from '../../shared/workbench'
import { detectShell } from '../exec'
import { parentWatchedCommand, redactLogText, shellCommand } from '../automation/rpc'
import { materializeSessionRuntime, type SessionRuntimeFiles } from './ide-profile'
import { PersistentRpc } from './ide-rpc'
import { validateAgentProfiles } from './profile'

const execFile = promisify(execFileCallback)
const STATE_VERSION = 1
const DIFF_LIMIT_BYTES = 2 * 1024 * 1024
const FILE_LIMIT_BYTES = 4 * 1024 * 1024
const HEARTBEAT_MAX_RUNS = 10_000
const VALID_THINKING: Record<string, true> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true, auto: true }
const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true }
const FIRE_AND_FORGET_UI_METHODS: Record<string, true> = {
  notify: true,
  setStatus: true,
  setWidget: true,
  setTitle: true,
  set_editor_text: true,
  open_url: true
}

interface StoredWorkbench {
  version: 1
  workspaces: Workspace[]
  sessions: AgentSession[]
  profiles: AgentProfile[]
  eventSequences: Record<string, number>
}

interface LiveSession {
  rpc?: PersistentRpc
  terminal?: IPty
  terminalClosed?: Promise<void>
  runtime?: SessionRuntimeFiles
  closing: boolean
}

export interface IDEBackendOptions {
  root: string
  getSettings(): MachineSettings
  getOmp(): PortableProfile['omp']
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function now(): string {
  return new Date().toISOString()
}

function boundedText(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== 'string') throw new Error(`${label}이(가) 문자열이 아닙니다`)
  const text = value.trim()
  if (!text || text.includes('\0') || Buffer.byteLength(text, 'utf8') > maximum) throw new Error(`${label}이(가) 비어 있거나 너무 깁니다`)
  return text
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function parseModel(value: unknown): { provider: string; modelId: string } {
  const row = objectRecord(value)
  if (!row) throw new Error('모델 선택 인자가 올바르지 않습니다')
  const provider = boundedText(row.provider, '모델 공급자', 128)
  const modelId = boundedText(row.modelId, '모델 ID', 512)
  return { provider, modelId }
}

function isWithin(root: string, candidate: string): boolean {
  const scoped = relative(root, candidate)
  return scoped === '' || (scoped !== '..' && !scoped.startsWith(`..${sep}`) && !isAbsolute(scoped))
}

function eventText(frame: Record<string, unknown>): string {
  for (const key of ['text', 'message', 'url', 'error', 'content']) {
    if (typeof frame[key] === 'string' && frame[key]) return String(frame[key])
  }
  return String(frame.type ?? 'OMP 이벤트')
}

function sessionModel(state: Record<string, unknown>, fallback: string): string {
  const model = objectRecord(state.model)
  if (!model) return fallback
  const provider = typeof model.provider === 'string' ? model.provider : ''
  const id = typeof model.id === 'string' ? model.id : ''
  return provider && id ? `${provider}/${id}` : id || fallback
}

export class IDEBackend implements IDEAPI {
  private readonly directory: string
  private readonly statePath: string
  private readonly logsDirectory: string
  private readonly worktreesDirectory: string
  private readonly runtimeDirectory: string
  private initialized = false
  private shuttingDown = false
  private workspaces: Workspace[] = []
  private sessions: AgentSession[] = []
  private profiles: AgentProfile[] = []
  private eventSequences: Record<string, number> = {}
  private readonly questions = new Map<string, AgentQuestion[]>()
  private readonly stateSnapshots = new Map<string, unknown>()
  private readonly messageBuffers = new Map<string, { assistant: string; thinking: string }>()
  private readonly live = new Map<string, LiveSession>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>()
  private persistence: Promise<void> = Promise.resolve()
  private modelCache?: { at: number; value: Array<{ id: string; name: string; provider: string }> }
  private modelLoading?: Promise<Array<{ id: string; name: string; provider: string }>>

  constructor(private readonly options: IDEBackendOptions) {
    this.directory = join(resolve(options.root), 'workbench')
    this.statePath = join(this.directory, 'state.json')
    this.logsDirectory = join(this.directory, 'events')
    this.worktreesDirectory = join(this.directory, 'worktrees')
    this.runtimeDirectory = join(this.directory, 'runtime')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.logsDirectory, { recursive: true, mode: 0o700 })
    await mkdir(this.worktreesDirectory, { recursive: true, mode: 0o700 })
    await mkdir(this.runtimeDirectory, { recursive: true, mode: 0o700 })
    try {
      const raw = await readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoredWorkbench>
      if (parsed.version !== STATE_VERSION || !Array.isArray(parsed.workspaces) || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.profiles)) {
        throw new Error('지원하지 않는 상태 형식입니다')
      }
      this.workspaces = parsed.workspaces
      this.sessions = parsed.sessions
      this.profiles = parsed.profiles
      this.eventSequences = (objectRecord(parsed.eventSequences) as Record<string, number> | undefined) ?? {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`IDE 상태를 읽을 수 없습니다: ${errorMessage(error)}`)
    }
    let changed = false
    for (const session of this.sessions) {
      this.questions.set(session.id, [])
      const persistedEvents = await this.readEvents(session.id, 0)
      const lastSequence = persistedEvents.at(-1)?.seq ?? 0
      this.eventSequences[session.id] = Math.max(this.eventSequences[session.id] ?? 0, lastSequence)
      if (session.status === 'running' || session.status === 'waiting' || session.status === 'idle') {
        session.status = 'stopped'
        session.updatedAt = now()
        changed = true
      }
      this.scheduleHeartbeat(session)
    }
    this.initialized = true
    if (changed) await this.saveState()
  }

  async snapshot(): Promise<WorkbenchSnapshot> {
    this.assertInitialized()
    return clone({ workspaces: this.workspaces, sessions: this.sessions, profiles: this.profiles })
  }

  async models(): Promise<Array<{ id: string; name: string; provider: string }>> {
    this.assertInitialized()
    if (this.modelCache && Date.now() - this.modelCache.at < 30_000) return this.modelCache.value
    if (this.modelLoading) return this.modelLoading
    this.modelLoading = this.discoverModels().then((value) => {
      this.modelCache = { at: Date.now(), value }
      return value
    }).finally(() => { this.modelLoading = undefined })
    return this.modelLoading
  }

  private async discoverModels(): Promise<Array<{ id: string; name: string; provider: string }>> {
    for (const [id, live] of this.live) {
      if (!live.rpc || live.rpc.isClosed) continue
      try {
        const response = await live.rpc.request('get_available_models')
        return this.normalizeModels(response.data)
      } catch (error) {
        await this.appendEvent(id, 'error', `모델 목록을 가져오지 못했습니다: ${redactLogText(errorMessage(error))}`)
      }
    }

    const workspace = this.workspaces.find((item) => !item.archived)
    const cwd = workspace?.cwd ?? resolve(this.options.root)
    const discoveryId = `models-${randomUUID()}`
    const runtime = await materializeSessionRuntime({
      runtimeRoot: this.runtimeDirectory,
      sessionId: discoveryId,
      workspaceCwd: cwd,
      omp: this.options.getOmp()
    })
    const args = [this.ompCommand(), '--mode', 'rpc', '--config', runtime.configPath, '--no-session', '--no-title']
    if (runtime.instructionsPath) args.push('--append-system-prompt', runtime.instructionsPath)
    const rpc = new PersistentRpc({
      command: parentWatchedCommand(shellCommand(args)),
      cwd,
      onFrame() {},
      onStderr() {},
      onExit() {}
    })
    try {
      await rpc.start()
      const response = await rpc.request('get_available_models')
      return this.normalizeModels(response.data)
    } finally {
      try {
        await rpc.shutdown()
      } finally {
        await rm(runtime.directory, { recursive: true, force: true })
      }
    }
  }

  async createWorkspace(input: { project: string; name: string; isolated: boolean; base?: string }): Promise<Workspace> {
    this.assertInitialized()
    const project = boundedText(input.project, '프로젝트', 1_024)
    const name = boundedText(input.name, '워크스페이스 이름', 128)
    if (this.workspaces.some((item) => !item.archived && item.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) {
      throw new Error(`같은 이름의 활성 워크스페이스가 있습니다: ${name}`)
    }
    const configured = this.options.getSettings().projectPaths[project]
    if (!configured) throw new Error('먼저 환경 설정에서 프로젝트 폴더를 연결하세요.')
    const projectPath = await realpath(resolve(configured))
    const projectInfo = await stat(projectPath)
    if (!projectInfo.isDirectory()) throw new Error(`프로젝트 경로가 디렉터리가 아닙니다: ${projectPath}`)

    const id = randomUUID()
    let cwd = projectPath
    let branch: string | undefined
    if (input.isolated) {
      const repositoryRoot = (await this.git(projectPath, ['rev-parse', '--show-toplevel'])).stdout.trim()
      if (!repositoryRoot) throw new Error('격리 워크스페이스는 Git 저장소가 필요합니다')
      const canonicalRepository = await realpath(repositoryRoot)
      if (!isWithin(canonicalRepository, projectPath)) throw new Error('프로젝트가 Git 저장소 범위를 벗어납니다')
      const projectRelative = relative(canonicalRepository, projectPath)
      branch = `palace/workbench/${id}`
      const worktree = join(this.worktreesDirectory, id)
      const base = input.base?.trim() || 'HEAD'
      await this.git(canonicalRepository, ['rev-parse', '--verify', `${base}^{commit}`])
      await this.git(canonicalRepository, ['worktree', 'add', '-b', branch, worktree, base])
      cwd = projectRelative ? join(worktree, projectRelative) : worktree
    }
    const workspace: Workspace = { id, project, name, cwd, branch, isolated: input.isolated, createdAt: now(), archived: false }
    this.workspaces.push(workspace)
    await this.saveState()
    return clone(workspace)
  }

  async archiveWorkspace(id: string): Promise<void> {
    this.assertInitialized()
    const workspace = this.workspace(id)
    if (workspace.archived) return
    const owned = this.sessions.filter((session) => session.workspaceId === id && session.status !== 'stopped')
    for (const session of owned) await this.closeSession(session.id)
    workspace.archived = true
    await this.saveState()
  }

  async createSession(input: { workspaceId: string; name: string; kind: 'agent' | 'terminal'; model?: string; profileId?: string }): Promise<AgentSession> {
    this.assertInitialized()
    const workspace = this.workspace(input.workspaceId)
    if (workspace.archived) throw new Error('보관된 워크스페이스에는 세션을 만들 수 없습니다')
    const name = boundedText(input.name, '세션 이름', 128)
    if (input.kind !== 'agent' && input.kind !== 'terminal') throw new Error('지원하지 않는 세션 종류입니다')
    if (this.sessions.some((item) => item.workspaceId === workspace.id && item.name === name && item.status !== 'stopped')) {
      throw new Error(`같은 이름의 활성 세션이 있습니다: ${name}`)
    }
    const profile = input.profileId ? this.profiles.find((item) => item.id === input.profileId) : undefined
    if (input.profileId && !profile) throw new Error('에이전트 프로필을 찾을 수 없습니다')
    const requestedModel = input.model?.trim() || profile?.model.trim() || ''
    const timestamp = now()
    const session: AgentSession = {
      id: randomUUID(),
      workspaceId: workspace.id,
      name,
      kind: input.kind,
      status: 'stopped',
      model: requestedModel && requestedModel.toLowerCase() !== 'auto' ? requestedModel : 'Auto',
      profileId: profile?.id,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    this.sessions.push(session)
    this.questions.set(session.id, [])
    this.eventSequences[session.id] = 0
    await this.saveState()
    await this.appendEvent(session.id, 'system', `${input.kind === 'agent' ? 'OMP 에이전트' : '터미널'} 세션을 시작합니다`)
    try {
      await this.startSession(session)
    } catch (error) {
      session.status = 'error'
      session.error = redactLogText(errorMessage(error))
      session.updatedAt = now()
      await this.appendEvent(session.id, 'error', session.error)
      await this.saveState()
      throw error
    }
    return clone(session)
  }

  async detail(id: string, after = 0): Promise<SessionDetail> {
    this.assertInitialized()
    const session = this.session(id)
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('이벤트 커서가 올바르지 않습니다')
    const events = await this.readEvents(session.id, after)
    return {
      session: clone(session),
      events,
      questions: clone(this.questions.get(id) ?? []),
      state: clone(this.stateSnapshots.get(id))
    }
  }

  async prompt(id: string, text: string, mode: 'prompt' | 'steer' | 'follow_up' = 'prompt'): Promise<void> {
    this.assertInitialized()
    const session = this.session(id)
    if (session.kind !== 'agent') throw new Error('프롬프트는 에이전트 세션에만 보낼 수 있습니다')
    const message = boundedText(text, '프롬프트', 1024 * 1024)
    if (!['prompt', 'steer', 'follow_up'].includes(mode)) throw new Error('지원하지 않는 프롬프트 모드입니다')
    await this.ensureLive(session)
    const rpc = this.requireRpc(session.id)
    await this.appendEvent(id, 'user', message, { mode })
    session.status = 'running'
    session.error = undefined
    session.updatedAt = now()
    await this.saveState()
    try {
      const response = await rpc.request(mode, { message })
      const data = objectRecord(response.data)
      if (mode === 'prompt' && data?.agentInvoked === false) {
        session.status = (this.questions.get(id)?.length ?? 0) > 0 ? 'waiting' : 'idle'
        session.updatedAt = now()
        await this.saveState()
      }
    } catch (error) {
      session.error = redactLogText(errorMessage(error))
      session.updatedAt = now()
      await this.appendEvent(id, 'error', session.error)
      await this.refreshState(session).catch(() => undefined)
      await this.saveState()
      throw error
    }
  }

  async respond(id: string, questionId: string, response: unknown): Promise<void> {
    this.assertInitialized()
    const session = this.session(id)
    if (session.kind !== 'agent') throw new Error('에이전트 질문에만 응답할 수 있습니다')
    const questions = this.questions.get(id) ?? []
    const question = questions.find((item) => item.id === questionId)
    if (!question) throw new Error('대기 중인 질문을 찾을 수 없습니다')
    const rpc = this.requireRpc(id)
    const supplied = objectRecord(response)
    let fields: Record<string, unknown>
    if (supplied && (typeof supplied.value === 'string' || typeof supplied.confirmed === 'boolean' || supplied.cancelled === true)) {
      fields = {}
      if (typeof supplied.value === 'string') fields.value = supplied.value
      if (typeof supplied.confirmed === 'boolean') fields.confirmed = supplied.confirmed
      if (supplied.cancelled === true) {
        fields.cancelled = true
        if (supplied.timedOut === true) fields.timedOut = true
      }
    } else if (question.method === 'confirm') {
      if (typeof response !== 'boolean') throw new Error('확인 질문 응답은 boolean이어야 합니다')
      fields = { confirmed: response }
    } else {
      if (typeof response !== 'string') throw new Error('질문 응답은 문자열이어야 합니다')
      fields = { value: response }
    }
    rpc.send({ type: 'extension_ui_response', id: questionId, ...fields })
    this.questions.set(id, questions.filter((item) => item.id !== questionId))
    await this.appendEvent(id, 'system', `${question.title} 질문에 응답했습니다`, { questionId, method: question.method })
    session.status = (this.questions.get(id)?.length ?? 0) > 0 ? 'waiting' : 'running'
    session.updatedAt = now()
    await this.saveState()
  }

  async abort(id: string): Promise<void> {
    this.assertInitialized()
    const session = this.session(id)
    const live = this.live.get(id)
    if (session.kind === 'terminal') {
      if (live) live.closing = true
      if (live?.terminal) await this.stopTerminal(live)
      session.status = 'stopped'
    } else if (live?.rpc && !live.rpc.isClosed) {
      await live.rpc.request('abort', {}, 5_000)
      this.questions.set(id, [])
      session.status = 'idle'
    } else {
      session.status = 'stopped'
    }
    session.error = undefined
    session.updatedAt = now()
    await this.appendEvent(id, 'system', '세션 실행을 중단했습니다')
    await this.saveState()
  }

  async resume(id: string): Promise<void> {
    this.assertInitialized()
    const session = this.session(id)
    if (session.status !== 'stopped' && session.status !== 'error') throw new Error('중지되거나 오류가 난 세션만 다시 시작할 수 있습니다')
    session.error = undefined
    await this.startSession(session)
  }

  async closeSession(id: string): Promise<void> {
    this.assertInitialized()
    const session = this.session(id)
    this.cancelHeartbeat(id)
    const live = this.live.get(id)
    if (live) live.closing = true
    if (live?.rpc) await live.rpc.shutdown(session.status === 'running')
    if (live?.terminal) await this.stopTerminal(live)
    this.live.delete(id)
    this.questions.set(id, [])
    session.status = 'stopped'
    session.error = undefined
    session.updatedAt = now()
    await this.appendEvent(id, 'system', '세션을 닫았습니다')
    await this.saveState()
    this.scheduleHeartbeat(session)
  }

  async command(id: string, command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.assertInitialized()
    const session = this.session(id)
    if (session.kind === 'terminal') return this.terminalCommand(session, command, args)
    await this.ensureLive(session)
    const fields = await this.validateAgentCommand(session, command, args)
    const response = await this.requireRpc(id).request(command, fields, command === 'compact' || command === 'handoff' ? 10 * 60_000 : 60_000)
    await this.refreshState(session).catch(() => undefined)
    return clone(response.data)
  }

  async changes(workspaceId: string): Promise<WorkspaceChanges> {
    this.assertInitialized()
    const workspace = this.workspace(workspaceId)
    const statusResult = await this.git(workspace.cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])
    const fields = statusResult.stdout.split('\0').filter(Boolean)
    const files: Array<{ path: string; status: string }> = []
    const untracked: string[] = []
    for (let index = 0; index < fields.length; index += 1) {
      const row = fields[index]
      const status = row.slice(0, 2)
      const path = row.slice(3)
      if ((status[0] === 'R' || status[0] === 'C') && fields[index + 1]) index += 1
      if (status === '??') untracked.push(path)
      files.push({ path, status })
    }
    const diffResult = await this.git(workspace.cwd, ['diff', '--no-ext-diff', '--binary', 'HEAD', '--', '.'], 16 * 1024 * 1024)
    let combined = diffResult.stdout
    let omittedLargeFile = false
    for (const path of untracked) {
      const candidate = resolve(workspace.cwd, path)
      if (!isWithin(resolve(workspace.cwd), candidate)) continue
      const info = await lstat(candidate)
      if (!info.isFile() || info.size > DIFF_LIMIT_BYTES) {
        omittedLargeFile = true
        continue
      }
      combined += await this.gitUntrackedDiff(workspace.cwd, path)
    }
    const bytes = Buffer.from(combined, 'utf8')
    const truncated = omittedLargeFile || bytes.byteLength > DIFF_LIMIT_BYTES
    const diff = bytes.byteLength > DIFF_LIMIT_BYTES
      ? new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, DIFF_LIMIT_BYTES))
      : combined
    return { files, diff, truncated }
  }

  async readFile(workspaceId: string, path: string): Promise<string> {
    this.assertInitialized()
    const workspace = this.workspace(workspaceId)
    if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) throw new Error('파일 경로는 워크스페이스 기준 상대 경로여야 합니다')
    const workspaceRoot = await realpath(workspace.cwd)
    const candidate = resolve(workspaceRoot, path)
    if (!isWithin(workspaceRoot, candidate)) throw new Error('파일 경로가 워크스페이스를 벗어납니다')
    const canonical = await realpath(candidate)
    if (!isWithin(workspaceRoot, canonical)) throw new Error('심볼릭 링크가 워크스페이스를 벗어납니다')
    const info = await lstat(canonical)
    if (!info.isFile() || info.size > FILE_LIMIT_BYTES) throw new Error('안전하게 읽을 수 있는 일반 파일이 아니거나 파일이 너무 큽니다')
    const content = await readFile(canonical)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(content)
    } catch {
      throw new Error('UTF-8 텍스트 파일만 읽을 수 있습니다')
    }
  }

  async saveProfiles(profiles: AgentProfile[]): Promise<void> {
    this.assertInitialized()
    this.profiles = validateAgentProfiles(profiles)
    await this.saveState()
  }

  async heartbeat(id: string, value: AgentSession['heartbeat'] | null): Promise<void> {
    this.assertInitialized()
    const session = this.session(id)
    if (session.kind !== 'agent') throw new Error('하트비트는 에이전트 세션에서만 사용할 수 있습니다')
    if (value === null) {
      session.heartbeat = undefined
    } else {
      if (!value || typeof value !== 'object') throw new Error('하트비트 설정이 올바르지 않습니다')
      if (!Number.isSafeInteger(value.seconds) || value.seconds < 60) throw new Error('하트비트 간격은 최소 60초여야 합니다')
      if (!Number.isSafeInteger(value.maxRuns) || value.maxRuns < 1 || value.maxRuns > HEARTBEAT_MAX_RUNS) throw new Error(`하트비트 최대 실행 수는 1~${HEARTBEAT_MAX_RUNS}이어야 합니다`)
      const prompt = boundedText(value.prompt, '하트비트 프롬프트', 64 * 1024)
      const existingRuns = session.heartbeat?.runs ?? 0
      const suppliedRuns = Number.isSafeInteger(value.runs) && value.runs >= 0 ? value.runs : 0
      session.heartbeat = {
        seconds: value.seconds,
        prompt,
        enabled: value.enabled === true,
        maxRuns: value.maxRuns,
        runs: Math.max(existingRuns, suppliedRuns)
      }
    }
    this.cancelHeartbeat(id)
    session.updatedAt = now()
    await this.saveState()
    this.scheduleHeartbeat(session)
  }

  async exportProfiles(): Promise<AgentProfile[]> {
    this.assertInitialized()
    return validateAgentProfiles(this.profiles)
  }

  async importProfiles(profiles: AgentProfile[]): Promise<void> {
    await this.saveProfiles(profiles)
  }

  async shutdown(): Promise<void> {
    if (!this.initialized || this.shuttingDown) return
    this.shuttingDown = true
    for (const timer of this.heartbeatTimers.values()) clearTimeout(timer)
    this.heartbeatTimers.clear()
    const active = [...this.live.entries()]
    await Promise.all(active.map(async ([id, live]) => {
      live.closing = true
      const session = this.sessions.find((item) => item.id === id)
      try {
        if (live.rpc) await live.rpc.shutdown(session?.status === 'running')
        if (live.terminal) await this.stopTerminal(live)
      } finally {
        if (session) {
          session.status = 'stopped'
          session.updatedAt = now()
        }
      }
    }))
    this.live.clear()
    await this.saveState()
    await this.persistence
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('IDEBackend.initialize()를 먼저 호출해야 합니다')
    if (this.shuttingDown) throw new Error('IDEBackend가 종료 중입니다')
  }

  private workspace(id: string): Workspace {
    const workspace = this.workspaces.find((item) => item.id === id)
    if (!workspace) throw new Error('워크스페이스를 찾을 수 없습니다')
    return workspace
  }

  private session(id: string): AgentSession {
    const session = this.sessions.find((item) => item.id === id)
    if (!session) throw new Error('세션을 찾을 수 없습니다')
    return session
  }

  private ompCommand(): string {
    const command = this.options.getSettings().ompCommand.trim()
    if (!command) throw new Error('OMP 명령이 구성되지 않았습니다')
    return command
  }

  private async startSession(session: AgentSession): Promise<void> {
    const current = this.starting.get(session.id)
    if (current) return current
    const start = (session.kind === 'agent' ? this.startAgent(session) : this.startTerminal(session)).finally(() => this.starting.delete(session.id))
    this.starting.set(session.id, start)
    return start
  }

  private async ensureLive(session: AgentSession): Promise<void> {
    const live = this.live.get(session.id)
    if (live && (live.rpc && !live.rpc.isClosed || live.terminal)) return
    await this.startSession(session)
  }

  private async startAgent(session: AgentSession): Promise<void> {
    const workspace = this.workspace(session.workspaceId)
    if (workspace.archived) throw new Error('보관된 워크스페이스의 세션은 다시 시작할 수 없습니다')
    const profile = session.profileId ? this.profiles.find((item) => item.id === session.profileId) : undefined
    const wasResume = Boolean(session.sessionFile)
    const runtime = await materializeSessionRuntime({
      runtimeRoot: this.runtimeDirectory,
      sessionId: session.id,
      workspaceCwd: workspace.cwd,
      projectSkills: join(this.options.getSettings().projectPaths[workspace.project] ?? workspace.cwd, '.agent', 'skills'),
      omp: this.options.getOmp(),
      profile
    })
    const args = [this.ompCommand(), '--mode', 'rpc-ui', '--config', runtime.configPath, '--session-dir', runtime.sessionsDirectory, '--no-title']
    if (runtime.instructionsPath) args.push('--append-system-prompt', runtime.instructionsPath)
    if (session.sessionFile) args.push('--resume', session.sessionFile)
    else if (session.model && session.model.toLowerCase() !== 'auto') args.push('--model', session.model)
    const thinking = profile?.thinking.trim().toLowerCase()
    if (thinking && thinking !== 'auto') args.push('--thinking', thinking)

    const live: LiveSession = { closing: false, runtime }
    const rpc = new PersistentRpc({
      command: parentWatchedCommand(shellCommand(args)),
      cwd: workspace.cwd,
      onFrame: (frame) => this.handleAgentFrame(session.id, frame),
      onStderr: (text) => {
        void this.appendEvent(session.id, 'error', redactLogText(text)).catch(() => undefined)
      },
      onExit: (error) => this.handleProcessExit(session.id, live, error)
    })
    live.rpc = rpc
    this.live.set(session.id, live)
    try {
      await rpc.start()
      await rpc.request('set_subagent_subscription', { level: 'events' }).catch(async (error) => {
        await this.appendEvent(session.id, 'system', `서브에이전트 이벤트 구독을 사용할 수 없습니다: ${redactLogText(errorMessage(error))}`)
      })
      session.status = 'idle'
      session.error = undefined
      session.updatedAt = now()
      await this.refreshState(session)
      await this.appendEvent(session.id, 'system', wasResume ? 'OMP 세션을 재개했습니다' : 'OMP RPC 세션이 준비되었습니다')
      await this.saveState()
      this.scheduleHeartbeat(session)
    } catch (error) {
      live.closing = true
      await rpc.shutdown().catch(() => undefined)
      this.live.delete(session.id)
      throw error
    }
  }

  private async startTerminal(session: AgentSession): Promise<void> {
    const workspace = this.workspace(session.workspaceId)
    if (workspace.archived) throw new Error('보관된 워크스페이스의 터미널은 다시 시작할 수 없습니다')
    const terminal = spawnPty(detectShell(), ['-l'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: workspace.cwd,
      env: process.env,
      encoding: 'utf8'
    })
    const live: LiveSession = { closing: false, terminal }
    let markTerminalClosed!: () => void
    live.terminalClosed = new Promise<void>((resolveClosed) => {
      markTerminalClosed = resolveClosed
    })
    this.live.set(session.id, live)
    terminal.onData((text) => {
      if (text) void this.appendEvent(session.id, 'terminal', text).catch(() => undefined)
    })
    terminal.onExit(({ exitCode, signal }) => {
      markTerminalClosed()
      const error = !live.closing && exitCode !== 0 ? new Error(`터미널이 종료되었습니다 (code ${exitCode}, signal ${signal ?? 0})`) : undefined
      this.handleProcessExit(session.id, live, error)
    })
    session.status = 'running'
    session.error = undefined
    session.updatedAt = now()
    await this.saveState()
  }

  private async stopTerminal(live: LiveSession): Promise<void> {
    const terminal = live.terminal
    if (!terminal || !live.terminalClosed) return
    let closed = false
    const ended = live.terminalClosed.then(() => { closed = true })
    try { terminal.kill('SIGHUP') } catch { /* PTY가 이미 닫혔다. */ }
    const timer = setTimeout(() => {
      if (!closed) {
        try { terminal.kill('SIGKILL') } catch { /* 종료와 경합했다. */ }
      }
    }, 2_000)
    timer.unref()
    try { await ended } finally { clearTimeout(timer) }
  }

  private handleProcessExit(id: string, expectedLive: LiveSession, error?: Error): void {
    if (this.live.get(id) !== expectedLive) return
    this.live.delete(id)
    this.questions.set(id, [])
    this.flushMessageBuffers(id)
    const session = this.sessions.find((item) => item.id === id)
    if (!session) return
    if (expectedLive.closing || this.shuttingDown) {
      session.status = 'stopped'
    } else if (error) {
      session.status = 'error'
      session.error = redactLogText(error.message)
      void this.appendEvent(id, 'error', session.error).catch(() => undefined)
    } else {
      session.status = 'stopped'
    }
    session.updatedAt = now()
    void this.saveState().catch(() => undefined)
  }

  private handleAgentFrame(id: string, frame: Record<string, unknown>): void {
    const session = this.sessions.find((item) => item.id === id)
    if (!session) return
    const type = String(frame.type ?? '')
    if (type === 'agent_start' || type === 'turn_start') {
      session.status = 'running'
      session.error = undefined
      session.updatedAt = now()
      void this.saveState().catch(() => undefined)
      return
    }
    if (type === 'agent_end' && frame.isTerminal !== false) {
      this.flushMessageBuffers(id)
      session.status = (this.questions.get(id)?.length ?? 0) > 0 ? 'waiting' : session.error ? 'error' : 'idle'
      session.updatedAt = now()
      void this.appendEvent(id, session.error ? 'error' : 'system', session.error || '에이전트 턴이 완료되었습니다', frame).catch(() => undefined)
      void this.refreshState(session).catch(() => undefined)
      void this.saveState().catch(() => undefined)
      return
    }
    if (type === 'prompt_result' && frame.agentInvoked === false) {
      session.status = (this.questions.get(id)?.length ?? 0) > 0 ? 'waiting' : 'idle'
      session.updatedAt = now()
      void this.saveState().catch(() => undefined)
      return
    }
    if (type === 'message_update') {
      const update = objectRecord(frame.assistantMessageEvent)
      const buffers = this.messageBuffers.get(id) ?? { assistant: '', thinking: '' }
      this.messageBuffers.set(id, buffers)
      if (update?.type === 'text_delta' && typeof update.delta === 'string') {
        buffers.assistant += update.delta
        if (buffers.assistant.includes('\n') || buffers.assistant.length >= 1_500) this.flushMessageBuffers(id, 'assistant')
      } else if (update?.type === 'thinking_delta' && typeof update.delta === 'string') {
        buffers.thinking += update.delta
        if (buffers.thinking.includes('\n') || buffers.thinking.length >= 1_500) this.flushMessageBuffers(id, 'thinking')
      }
      return
    }
    if (type === 'tool_execution_start' || type === 'tool_execution_update' || type === 'tool_execution_end') {
      this.flushMessageBuffers(id)
      const phase = type === 'tool_execution_start' ? 'start' : type === 'tool_execution_end' ? 'end' : 'update'
      const toolName = typeof frame.toolName === 'string' ? frame.toolName : 'tool'
      const text = phase === 'start' ? `${toolName} 시작` : phase === 'end' ? `${toolName} ${frame.isError === true ? '실패' : '완료'}` : `${toolName} 진행 중`
      void this.appendEvent(id, 'tool', text, { phase, raw: frame }).catch(() => undefined)
      return
    }
    if (type === 'extension_ui_request') {
      this.flushMessageBuffers(id)
      this.handleUiRequest(session, frame)
      return
    }
    if (type === 'extension_error') {
      void this.appendEvent(id, 'error', `OMP 확장 오류: ${redactLogText(eventText(frame))}`, frame).catch(() => undefined)
      return
    }
    if (type === 'message_end') {
      this.flushMessageBuffers(id)
      const message = objectRecord(frame.message)
      if (message?.stopReason === 'error') {
        session.error = redactLogText(typeof message.errorMessage === 'string' ? message.errorMessage : 'OMP 모델 응답이 실패했습니다')
        session.updatedAt = now()
        void this.appendEvent(id, 'error', session.error).catch(() => undefined)
        void this.saveState().catch(() => undefined)
      }
      if (message && (message.usage !== undefined || message.cost !== undefined)) {
        void this.appendEvent(id, 'system', '사용량이 업데이트되었습니다', { usage: message.usage, cost: message.cost }).catch(() => undefined)
      }
      return
    }
    if (type.startsWith('subagent_')) {
      void this.appendEvent(id, 'tool', `서브에이전트: ${type}`, frame).catch(() => undefined)
      return
    }
    if (['auto_compaction_start', 'auto_compaction_end', 'auto_retry_start', 'auto_retry_end', 'model_changed', 'thinking_level_changed', 'notice', 'goal_updated', 'command_output', 'session_info_update', 'config_update'].includes(type)) {
      void this.appendEvent(id, type.includes('error') ? 'error' : 'system', eventText(frame), frame).catch(() => undefined)
    }
  }

  private flushMessageBuffers(id: string, only?: 'assistant' | 'thinking'): void {
    const buffers = this.messageBuffers.get(id)
    if (!buffers) return
    if ((!only || only === 'assistant') && buffers.assistant) {
      const text = buffers.assistant
      buffers.assistant = ''
      if (text.trim()) void this.appendEvent(id, 'assistant', text).catch(() => undefined)
    }
    if ((!only || only === 'thinking') && buffers.thinking) {
      const text = buffers.thinking
      buffers.thinking = ''
      if (text.trim()) void this.appendEvent(id, 'thinking', text).catch(() => undefined)
    }
    if (!buffers.assistant && !buffers.thinking) this.messageBuffers.delete(id)
  }

  private handleUiRequest(session: AgentSession, frame: Record<string, unknown>): void {
    const method = typeof frame.method === 'string' ? frame.method : ''
    const id = typeof frame.id === 'string' ? frame.id : ''
    if (method === 'cancel') {
      const target = typeof frame.targetId === 'string' ? frame.targetId : id
      this.questions.set(session.id, (this.questions.get(session.id) ?? []).filter((item) => item.id !== target))
      session.status = (this.questions.get(session.id)?.length ?? 0) > 0 ? 'waiting' : 'running'
      void this.saveState().catch(() => undefined)
      return
    }
    if (FIRE_AND_FORGET_UI_METHODS[method]) {
      void this.appendEvent(session.id, 'system', eventText(frame), frame).catch(() => undefined)
      return
    }
    if (!DIALOG_METHODS[method] || !id) {
      void this.appendEvent(session.id, 'error', `지원하지 않는 OMP UI 요청: ${method || 'unknown'}`, frame).catch(() => undefined)
      return
    }
    const question: AgentQuestion = {
      id,
      method,
      title: typeof frame.title === 'string' ? frame.title : 'OMP 질문',
      message: typeof frame.message === 'string' ? frame.message : undefined,
      options: method === 'confirm'
        ? [{ label: '확인', value: true }, { label: '취소', value: false }]
        : Array.isArray(frame.options) ? frame.options : undefined,
      data: clone(frame)
    }
    const questions = this.questions.get(session.id) ?? []
    this.questions.set(session.id, [...questions.filter((item) => item.id !== id), question])
    session.status = 'waiting'
    session.updatedAt = now()
    void this.appendEvent(session.id, 'system', question.title, { questionId: id, method, pending: true }).catch(() => undefined)
    void this.saveState().catch(() => undefined)
  }

  private requireRpc(id: string): PersistentRpc {
    const rpc = this.live.get(id)?.rpc
    if (!rpc || rpc.isClosed) throw new Error('OMP RPC 세션이 실행 중이 아닙니다')
    return rpc
  }

  private async refreshState(session: AgentSession): Promise<void> {
    const rpc = this.live.get(session.id)?.rpc
    if (!rpc || rpc.isClosed) return
    const response = await rpc.request('get_state')
    const state = objectRecord(response.data)
    if (!state) return
    this.stateSnapshots.set(session.id, state)
    session.model = sessionModel(state, session.model)
    if (typeof state.sessionFile === 'string' && state.sessionFile) session.sessionFile = state.sessionFile
    if (state.isStreaming === true) session.status = 'running'
    else if ((this.questions.get(session.id)?.length ?? 0) > 0) session.status = 'waiting'
    else if (session.status !== 'stopped' && session.status !== 'error') session.status = 'idle'
    session.updatedAt = now()
    await this.appendEvent(session.id, 'system', '세션 상태가 업데이트되었습니다', {
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      isStreaming: state.isStreaming,
      isCompacting: state.isCompacting,
      sessionFile: state.sessionFile,
      contextUsage: state.contextUsage,
      tokensPerSecond: state.tokensPerSecond
    })
    await this.saveState()
  }

  private async validateAgentCommand(session: AgentSession, command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const noArguments = [
      'get_state', 'get_session_stats', 'get_messages', 'get_last_assistant_text', 'get_available_commands', 'get_available_models',
      'get_branch_messages', 'get_subagents', 'cycle_model', 'cycle_thinking_level', 'abort_retry'
    ]
    if (noArguments.includes(command)) return {}
    if (command === 'set_model') return parseModel(args)
    if (command === 'set_thinking_level') {
      const level = boundedText(args.level, '사고 수준', 32).toLowerCase()
      if (!VALID_THINKING[level] || level === 'auto') throw new Error('RPC 사고 수준은 off~max 중 하나여야 합니다')
      return { level }
    }
    if (command === 'set_auto_compaction' || command === 'set_auto_retry' || command === 'set_fast_mode') {
      if (typeof args.enabled !== 'boolean') throw new Error(`${command} enabled 값은 boolean이어야 합니다`)
      return { enabled: args.enabled }
    }
    if (command === 'set_steering_mode' || command === 'set_follow_up_mode') {
      if (args.mode !== 'all' && args.mode !== 'one-at-a-time') throw new Error('큐 모드가 올바르지 않습니다')
      return { mode: args.mode }
    }
    if (command === 'set_interrupt_mode') {
      if (args.mode !== 'immediate' && args.mode !== 'wait') throw new Error('인터럽트 모드가 올바르지 않습니다')
      return { mode: args.mode }
    }
    if (command === 'set_subagent_subscription') {
      if (args.level !== 'off' && args.level !== 'progress' && args.level !== 'events') throw new Error('서브에이전트 구독 수준이 올바르지 않습니다')
      return { level: args.level }
    }
    if (command === 'get_subagent_messages') {
      const result: Record<string, unknown> = {}
      if (args.subagentId !== undefined) result.subagentId = boundedText(args.subagentId, '서브에이전트 ID', 256)
      if (args.sessionFile !== undefined) result.sessionFile = await this.safeSessionPath(session, args.sessionFile)
      if (args.fromByte !== undefined) {
        if (!Number.isSafeInteger(args.fromByte) || Number(args.fromByte) < 0) throw new Error('fromByte가 올바르지 않습니다')
        result.fromByte = args.fromByte
      }
      if (!result.subagentId && !result.sessionFile) throw new Error('subagentId 또는 sessionFile이 필요합니다')
      return result
    }
    if (command === 'compact' || command === 'handoff') {
      if (args.customInstructions === undefined) return {}
      return { customInstructions: boundedText(args.customInstructions, '사용자 지침', 64 * 1024) }
    }
    if (command === 'set_session_name') return { name: boundedText(args.name, '세션 이름', 128) }
    if (command === 'new_session') {
      if (args.parentSession === undefined) return {}
      return { parentSession: await this.safeSessionPath(session, args.parentSession) }
    }
    if (command === 'branch') return { entryId: boundedText(args.entryId, '엔트리 ID', 256) }
    if (command === 'switch_session') return { sessionPath: await this.safeSessionPath(session, args.sessionPath) }
    if (command === 'export_html') {
      if (args.outputPath === undefined) return {}
      const workspace = this.workspace(session.workspaceId)
      const output = resolve(workspace.cwd, boundedText(args.outputPath, '내보내기 경로', 1_024))
      if (!isWithin(await realpath(workspace.cwd), output)) throw new Error('내보내기 경로가 워크스페이스를 벗어납니다')
      return { outputPath: output }
    }
    throw new Error(`허용되지 않는 OMP RPC 명령입니다: ${command}`)
  }

  private async safeSessionPath(session: AgentSession, value: unknown): Promise<string> {
    const requested = boundedText(value, '세션 파일', 2_048)
    const runtime = this.live.get(session.id)?.runtime
    const sessionsRoot = runtime?.sessionsDirectory ?? join(this.runtimeDirectory, session.id, 'sessions')
    const canonicalRoot = await realpath(sessionsRoot)
    const canonical = await realpath(isAbsolute(requested) ? requested : resolve(canonicalRoot, requested))
    if (!isWithin(canonicalRoot, canonical)) throw new Error('세션 파일이 이 에이전트의 저장소를 벗어납니다')
    return canonical
  }

  private async terminalCommand(session: AgentSession, command: string, args: Record<string, unknown>): Promise<unknown> {
    const live = this.live.get(session.id)
    const terminal = live?.terminal
    if (!terminal) throw new Error('터미널 세션이 실행 중이 아닙니다')
    if (command === 'terminal.input') {
      if (typeof args.data !== 'string' || args.data.includes('\0') || Buffer.byteLength(args.data, 'utf8') > 1024 * 1024) throw new Error('터미널 입력이 올바르지 않거나 너무 큽니다')
      terminal.write(args.data)
      return undefined
    }
    if (command === 'terminal.resize') {
      if (!Number.isSafeInteger(args.columns) || !Number.isSafeInteger(args.rows) || Number(args.columns) < 20 || Number(args.columns) > 500 || Number(args.rows) < 5 || Number(args.rows) > 300) {
        throw new Error('터미널 크기가 올바르지 않습니다')
      }
      terminal.resize(Number(args.columns), Number(args.rows))
      return { columns: args.columns, rows: args.rows }
    }
    throw new Error(`허용되지 않는 터미널 명령입니다: ${command}`)
  }

  private normalizeModels(data: unknown): Array<{ id: string; name: string; provider: string }> {
    const models = objectRecord(data)?.models
    if (!Array.isArray(models)) throw new Error('OMP 모델 목록 응답이 올바르지 않습니다')
    const result: Array<{ id: string; name: string; provider: string }> = []
    const seen = new Set<string>()
    for (const item of models) {
      const row = objectRecord(item)
      if (!row || typeof row.id !== 'string' || typeof row.provider !== 'string') continue
      const key = `${row.provider}/${row.id}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ id: row.id, name: typeof row.name === 'string' && row.name ? row.name : row.id, provider: row.provider })
    }
    return result.sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name))
  }

  private async git(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer })
      return { stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const detail = error as Error & { stderr?: string; stdout?: string }
      throw new Error(`Git 명령에 실패했습니다: ${(detail.stderr || detail.stdout || detail.message).trim()}`)
    }
  }

  private async gitUntrackedDiff(cwd: string, path: string): Promise<string> {
    try {
      const result = await execFile('git', ['-C', cwd, 'diff', '--no-index', '--binary', '--', '/dev/null', path], {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024
      })
      return result.stdout
    } catch (error) {
      const detail = error as Error & { code?: number | string; stderr?: string; stdout?: string }
      if (Number(detail.code) === 1) return detail.stdout ?? ''
      throw new Error(`추적되지 않은 파일 diff에 실패했습니다: ${(detail.stderr || detail.stdout || detail.message).trim()}`)
    }
  }

  private async appendEvent(id: string, kind: SessionEvent['kind'], text: string, data?: unknown): Promise<void> {
    const seq = (this.eventSequences[id] ?? 0) + 1
    this.eventSequences[id] = seq
    const event: SessionEvent = { seq, at: now(), kind, text, data }
    const line = `${JSON.stringify(event)}\n`
    await this.enqueuePersistence(async () => {
      await appendFile(join(this.logsDirectory, `${id}.jsonl`), line, { encoding: 'utf8', mode: 0o600 })
    })
  }

  private async readEvents(id: string, after: number): Promise<SessionEvent[]> {
    try {
      const raw = await readFile(join(this.logsDirectory, `${id}.jsonl`), 'utf8')
      const events: SessionEvent[] = []
      const lines = raw.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (!line) continue
        try {
          const event = JSON.parse(line) as SessionEvent
          if (Number.isSafeInteger(event.seq) && event.seq > after) events.push(event)
        } catch (error) {
          if (index === lines.length - 1 && !raw.endsWith('\n')) break
          throw error
        }
      }
      return events
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`세션 이벤트를 읽을 수 없습니다: ${errorMessage(error)}`)
    }
  }

  private async saveState(): Promise<void> {
    const value: StoredWorkbench = {
      version: STATE_VERSION,
      workspaces: this.workspaces,
      sessions: this.sessions,
      profiles: this.profiles,
      eventSequences: this.eventSequences
    }
    const body = `${JSON.stringify(value, null, 2)}\n`
    await this.enqueuePersistence(async () => {
      const temporary = join(this.directory, `.state.${process.pid}.${randomUUID()}.tmp`)
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.statePath)
    })
  }

  private enqueuePersistence(operation: () => Promise<void>): Promise<void> {
    const result = this.persistence.then(operation)
    this.persistence = result.catch(() => undefined)
    return result
  }

  private scheduleHeartbeat(session: AgentSession): void {
    this.cancelHeartbeat(session.id)
    const heartbeat = session.heartbeat
    if (this.shuttingDown || session.status === 'stopped' || session.status === 'error' || !heartbeat?.enabled || heartbeat.runs >= heartbeat.maxRuns) return
    const timer = setTimeout(() => {
      this.heartbeatTimers.delete(session.id)
      void this.runHeartbeat(session.id).catch(async (error) => {
        await this.appendEvent(session.id, 'error', `하트비트 실행 실패: ${redactLogText(errorMessage(error))}`).catch(() => undefined)
      })
    }, heartbeat.seconds * 1_000)
    timer.unref()
    this.heartbeatTimers.set(session.id, timer)
  }

  private cancelHeartbeat(id: string): void {
    const timer = this.heartbeatTimers.get(id)
    if (timer) clearTimeout(timer)
    this.heartbeatTimers.delete(id)
  }

  private async runHeartbeat(id: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === id)
    if (!session?.heartbeat || !session.heartbeat.enabled || session.heartbeat.runs >= session.heartbeat.maxRuns || this.shuttingDown) return
    if (session.status !== 'idle' || (this.questions.get(id)?.length ?? 0) > 0) {
      this.scheduleHeartbeat(session)
      return
    }
    session.heartbeat.runs += 1
    if (session.heartbeat.runs >= session.heartbeat.maxRuns) session.heartbeat.enabled = false
    await this.saveState()
    try {
      await this.prompt(id, session.heartbeat.prompt, 'prompt')
    } finally {
      this.scheduleHeartbeat(session)
    }
  }
}
