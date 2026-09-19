import type { AgentProfile } from './workbench'

// OMP 자동화의 이식 가능한 정의와 머신 전용 상태를 분리한다.
export type Trigger =
  | { kind: 'manual' }
  | { kind: 'interval'; seconds: number }
  | { kind: 'daily'; time: string; timezone: string }
  | { kind: 'cron'; expression: string; timezone: string }
  | { kind: 'github'; repository: string; event: 'issue_opened' | 'pull_request_review' | 'workflow_failed'; pollSeconds: number }
  | { kind: 'webhook' }

export interface LoopDefinition {
  id: string
  name: string
  project: string
  mission: string
  trigger: Trigger
  model: string
  checks: string[]
  maxAttempts: number
  timeoutMinutes: number
  enabled: boolean
}

export interface PortableProfile {
  version: 1
  omp: { config: Record<string, unknown>; instructions: string; skills: Record<string, string> }
  loops: LoopDefinition[]
  workbench?: {
    profiles: AgentProfile[]
    skills: Record<string, Array<{ id: string; source: string; revision: string; skillPath: string }>>
    engine?: { loops: Record<string, { config: Record<string, unknown>; mission: string; vision?: string }>; products: Record<string, Record<string, unknown>> }
  }
}

export interface MachineSettings {
  projectPaths: Record<string, string>
  ompCommand: string
  armed: boolean
  maxConcurrentRuns: number
  syncRemote: string
  syncBranch: string
}

export type RunStatus = 'queued' | 'running' | 'checking' | 'succeeded' | 'needs-review' | 'failed' | 'cancelled' | 'interrupted'
export interface AutomationRun {
  id: string
  loopId: string
  loopName: string
  trigger: string
  status: RunStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  attempt: number
  worktree?: string
  branch?: string
  error?: string
  sessionFile?: string
}
export interface RunLog { seq: number; at: string; kind: 'system' | 'assistant' | 'tool' | 'check' | 'error'; text: string }
export interface SyncStatus { connected: boolean; remote: string; branch: string; dirty: boolean; lastSync?: string; message?: string }
export interface AutomationSnapshot {
  online: boolean
  version: string
  machineId: string
  settings: MachineSettings
  profile: PortableProfile
  approved: Record<string, boolean>
  runs: AutomationRun[]
  sync: SyncStatus
  schedules?: Record<string, string>
  schedulerErrors?: Record<string, string>
  schedulerError?: string
}
export interface RunDetail { run: AutomationRun; logs: RunLog[] }
export interface ServiceStatus { running: boolean; installed: boolean; message: string }
export interface WebhookAccess { url: string; token: string }

export interface AutomationAPI {
  snapshot(): Promise<AutomationSnapshot>
  saveLoop(loop: LoopDefinition): Promise<AutomationSnapshot>
  deleteLoop(id: string): Promise<AutomationSnapshot>
  approveLoop(id: string): Promise<AutomationSnapshot>
  runLoop(id: string): Promise<AutomationRun>
  cancelRun(id: string): Promise<void>
  runDetail(id: string, after?: number): Promise<RunDetail>
  saveSettings(settings: MachineSettings): Promise<AutomationSnapshot>
  saveOmp(omp: PortableProfile['omp']): Promise<AutomationSnapshot>
  importOmp(): Promise<AutomationSnapshot>
  sync(direction: 'push' | 'pull'): Promise<AutomationSnapshot>
  webhook(id: string): Promise<WebhookAccess>
  service(action: 'status' | 'install' | 'uninstall'): Promise<ServiceStatus>
}

export const AUTOMATION_PORT = 48731
