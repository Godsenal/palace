import type { AutomationSnapshot } from './automation'

export interface CmuxSurface {
  workspaceId: string
  surfaceId: string
  workspaceName: string
  title: string
}
export interface CmuxSnapshot {
  available: boolean
  surfaces: CmuxSurface[]
  error?: string
}
export interface CompanionSnapshot {
  automation: AutomationSnapshot
  cmux: CmuxSnapshot
}
export type CmuxKey = 'Enter' | 'Escape' | 'Ctrl+C' | 'Up' | 'Down' | 'Tab'

// All calls: POST /api {method,args}; Authorization: Bearer <pairing token>.
// Responses: {result:T} or a non-2xx {error:string}. No arbitrary RPC forwarding.
// snapshot() -> CompanionSnapshot
// saveLoop(LoopDefinition), approveLoop(id), deleteLoop(id) -> AutomationSnapshot
// runLoop(id) -> AutomationRun; cancelRun(id) -> null; runDetail(id,after?) -> RunDetail
// saveSettings(MachineSettings) -> AutomationSnapshot; importOmp() -> AutomationSnapshot
// cmux.read(workspaceId,surfaceId) -> {text:string}
// cmux.send(workspaceId,surfaceId,text) -> null (paste only; no automatic Enter)
// cmux.key(workspaceId,surfaceId,CmuxKey) -> null
// cmux.openRun(runId) -> null (finished runs only, resume native OMP in worktree)
// skills.locations() -> SkillLocations; skills.search(query) -> SkillCandidate[]
// skills.preview(source,id?) -> SkillPreview (required before install/update)
// skills.list(SkillTarget) -> InstalledSkill[]
// skills.install(SkillTarget,source,id,revision), skills.update(SkillTarget,id,revision) -> InstalledSkill
// skills.remove(SkillTarget,id) -> null (tracked, unmodified installs only)
