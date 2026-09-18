export interface AgentProfile { id: string; name: string; model: string; thinking: string; instructions: string; whenToUse: string }
export interface Workspace { id: string; project: string; name: string; cwd: string; branch?: string; isolated: boolean; createdAt: string; archived: boolean }
export interface AgentSession { id: string; workspaceId: string; name: string; kind: 'agent' | 'terminal'; status: 'idle' | 'running' | 'waiting' | 'stopped' | 'error'; model: string; profileId?: string; createdAt: string; updatedAt: string; sessionFile?: string; error?: string; heartbeat?: { seconds: number; prompt: string; enabled: boolean; maxRuns: number; runs: number } }
export interface SessionEvent { seq: number; at: string; kind: 'user' | 'assistant' | 'thinking' | 'tool' | 'system' | 'error' | 'terminal'; text: string; data?: unknown }
export interface AgentQuestion { id: string; method: string; title: string; message?: string; options?: unknown[]; data?: unknown }
export interface SessionDetail { session: AgentSession; events: SessionEvent[]; questions: AgentQuestion[]; state?: unknown }
export interface WorkspaceChanges { files: Array<{ path: string; status: string }>; diff: string; truncated: boolean }
export interface WorkbenchSnapshot { workspaces: Workspace[]; sessions: AgentSession[]; profiles: AgentProfile[] }
export interface IDEAPI {
  snapshot(): Promise<WorkbenchSnapshot>
  models(): Promise<Array<{ id: string; name: string; provider: string }>>
  createWorkspace(input: { project: string; name: string; isolated: boolean; base?: string }): Promise<Workspace>
  archiveWorkspace(id: string): Promise<void>
  createSession(input: { workspaceId: string; name: string; kind: 'agent' | 'terminal'; model?: string; profileId?: string }): Promise<AgentSession>
  detail(id: string, after?: number): Promise<SessionDetail>
  prompt(id: string, text: string, mode?: 'prompt' | 'steer' | 'follow_up'): Promise<void>
  respond(id: string, questionId: string, response: unknown): Promise<void>
  abort(id: string): Promise<void>
  resume(id: string): Promise<void>
  closeSession(id: string): Promise<void>
  command(id: string, command: string, args?: Record<string, unknown>): Promise<unknown>
  changes(workspaceId: string): Promise<WorkspaceChanges>
  readFile(workspaceId: string, path: string): Promise<string>
  saveProfiles(profiles: AgentProfile[]): Promise<void>
  heartbeat(id: string, value: AgentSession['heartbeat'] | null): Promise<void>
}
export interface SkillCandidate { id: string; name: string; description: string; source: string; path: string; installs?: number }
export interface SkillPreview { source: string; revision: string; candidates: SkillCandidate[]; selected?: { id: string; files: Array<{ path: string; content: string }>; bytes: number } }
export interface InstalledSkill { id: string; name: string; description: string; source: string; revision: string; installedAt: string; modified: boolean; path: string }
export interface SkillsAPI {
  search(query: string): Promise<SkillCandidate[]>
  preview(source: string, skillId?: string): Promise<SkillPreview>
  list(project: string): Promise<InstalledSkill[]>
  install(project: string, source: string, skillId: string, revision: string): Promise<InstalledSkill>
  update(project: string, id: string, revision: string): Promise<InstalledSkill>
  remove(project: string, id: string): Promise<void>
}
export interface EngineStatus { available: boolean; running: boolean; url?: string; message?: string; root: string; prerequisites: Array<{ name: string; available: boolean; message?: string }> }
export interface LoopsEngineAPI {
  status(): Promise<EngineStatus>
  start(): Promise<EngineStatus>
  stop(): Promise<void>
  request(path: string, method?: 'GET' | 'POST', body?: unknown): Promise<unknown>
}
export interface NativeOmpHost { instanceId: string; generation: number; pid: number; sessionId: string; sessionName: string | null; cwd: string; model: { provider: string; id: string } | null; startedAt: number; participants: number; relayConnected: boolean; inputRequired: boolean; access: 'view' | 'control'; workspaceRef?: string }
export interface CmuxWorkspace { ref: string; title: string; cwd: string }
export interface RemoteStatus { available: boolean; cmuxAvailable: boolean; message?: string; hosts: NativeOmpHost[]; workspaces: CmuxWorkspace[] }
export interface NativeOmpLink { instanceId: string; generation: number; access: 'view' | 'control'; url: string }
export interface NativeOmpLaunch { project: string; model?: string; profileId?: string; access: 'off' | 'view' | 'control' }
export interface RemoteAPI {
  status(): Promise<RemoteStatus>
  launch(input: NativeOmpLaunch): Promise<{ workspaceRef: string; cwd: string; pid?: number; message?: string }>
  link(instanceId: string, generation: number, access: 'view' | 'control'): Promise<NativeOmpLink>
  focus(workspaceRef: string): Promise<void>
}
export interface WorkbenchServices { ide: IDEAPI; skills: SkillsAPI; loops: LoopsEngineAPI; remote: RemoteAPI }
export interface SetupStatus { tools: Array<{ id: string; name: string; available: boolean; authenticated?: boolean; optional?: boolean; message: string }>; projects: Array<{ name: string; path: string }>; platform: string }
export interface SetupAPI {
  status(): Promise<SetupStatus>
  repositories(): Promise<Array<{ name: string; url: string; private: boolean }>>
  install(tool: 'omp' | 'gh' | 'cmux' | 'tailscale' | 'bun' | 'node' | 'git'): Promise<SetupStatus>
  login(tool: 'omp' | 'gh' | 'tailscale'): Promise<{ message: string }>
  chooseProject(): Promise<{ name: string; path: string } | null>
}
export const WORKBENCH_METHODS: Record<string, readonly string[]> = {
  ide: ['snapshot','models','createWorkspace','archiveWorkspace','createSession','detail','prompt','respond','abort','resume','closeSession','command','changes','readFile','saveProfiles','heartbeat'],
  skills: ['search','preview','list','install','update','remove'],
  loops: ['status','start','stop','request'],
  remote: ['status','launch','link','focus'],
  setup: ['status','repositories','install','login','chooseProject']
}
