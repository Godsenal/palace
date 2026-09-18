import type { AutomationRun, LoopDefinition, MachineSettings, PortableProfile, RunLog, SyncStatus } from '../../shared/automation'

export interface RunOptions {
  definition: LoopDefinition
  runId: string
  projectPath: string
  root: string
  ompCommand: string
  omp: PortableProfile['omp']
  signal: AbortSignal
  triggerContext: string
  onLog(log: Omit<RunLog, 'seq' | 'at'>): void
  onUpdate(patch: Partial<AutomationRun>): void
}
export interface RunOutcome { status: 'succeeded' | 'needs-review'; worktree: string; branch: string; sessionFile?: string }

export interface SyncOptions {
  root: string
  getProfile(): PortableProfile
  setProfile(profile: PortableProfile): void
  getSettings(): MachineSettings
}
// runner.ts exports runAutomation(options: RunOptions): Promise<RunOutcome>.
// profileSync.ts exports ProfileSync with status(), push(), pull(), importOmp().
// status(): Promise<SyncStatus>; push()/pull(): Promise<void>;
// importOmp(): Promise<PortableProfile['omp']>.
// profileSync.ts also exports validatePortableProfile(value: unknown): PortableProfile.
// Service is the only writer of profile/local state; sync callbacks must invalidate approvals.
