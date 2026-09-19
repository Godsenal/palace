export interface AgentProfile { id: string; name: string; model: string; thinking: string; instructions: string; whenToUse: string }
export interface OmpAPI {
  models(): Promise<Array<{ id: string; name: string; provider: string }>>
  profiles(): Promise<AgentProfile[]>
  saveProfiles(profiles: AgentProfile[]): Promise<void>
}
export interface SkillCandidate { id: string; name: string; description: string; source: string; path: string; installs?: number }
export interface SkillPreview { source: string; revision: string; candidates: SkillCandidate[]; selected?: { id: string; files: Array<{ path: string; content: string }>; bytes: number } }
export interface InstalledSkill { id: string; name: string; description: string; source: string; revision: string; installedAt: string; modified: boolean; path: string }
export type SkillTarget = { scope: 'project'; project: string } | { scope: 'global' }
export interface SkillLocations { globalPath: string; projects: Record<string, string> }
export interface SkillsAPI {
  locations(): Promise<SkillLocations>
  search(query: string): Promise<SkillCandidate[]>
  preview(source: string, skillId?: string): Promise<SkillPreview>
  list(target: SkillTarget): Promise<InstalledSkill[]>
  install(target: SkillTarget, source: string, skillId: string, revision: string): Promise<InstalledSkill>
  update(target: SkillTarget, id: string, revision: string): Promise<InstalledSkill>
  remove(target: SkillTarget, id: string): Promise<void>
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
export interface WorkbenchServices { omp: OmpAPI; skills: SkillsAPI; loops: LoopsEngineAPI; remote: RemoteAPI }
export interface SetupStatus { tools: Array<{ id: string; name: string; available: boolean; authenticated?: boolean; optional?: boolean; message: string }>; projects: Array<{ name: string; path: string }>; platform: string }
export interface SetupAPI {
  status(): Promise<SetupStatus>
  repositories(): Promise<Array<{ name: string; url: string; private: boolean }>>
  install(tool: 'omp' | 'gh' | 'cmux' | 'tailscale' | 'bun' | 'node' | 'git'): Promise<SetupStatus>
  login(tool: 'omp' | 'gh' | 'tailscale'): Promise<{ message: string }>
  chooseProject(): Promise<{ name: string; path: string } | null>
}
export const WORKBENCH_METHODS: Record<string, readonly string[]> = {
  omp: ['models','profiles','saveProfiles'],
  skills: ['locations','search','preview','list','install','update','remove'],
  loops: ['status','start','stop','request'],
  remote: ['status','launch','link','focus'],
  setup: ['status','repositories','install','login','chooseProject']
}
