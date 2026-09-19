import type { AutomationRun, AutomationSnapshot, LoopDefinition, MachineSettings, RunDetail } from '../../shared/automation'
import type { CmuxKey, CompanionSnapshot } from '../../shared/companion'
import type { InstalledSkill, SkillCandidate, SkillLocations, SkillPreview, SkillTarget } from '../../shared/workbench'

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ApiError'
  }
}

type Envelope<T> = { result: T } | { error: string }

export class CompanionApi {
  constructor(private readonly getToken: () => string) {}

  private async call<T>(method: string, args: unknown[] = []): Promise<T> {
    let response: Response
    try {
      response = await fetch('/api', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.getToken()}`,
          'Content-Type': 'application/json'
        },
        cache: 'no-store',
        body: JSON.stringify({ method, args })
      })
    } catch {
      throw new ApiError('서버에 연결할 수 없습니다. 네트워크와 companion 서비스를 확인하세요.', 0)
    }

    let payload: Envelope<T>
    try {
      payload = await response.json() as Envelope<T>
    } catch {
      throw new ApiError(`서버가 올바르지 않은 응답을 보냈습니다 (${response.status}).`, response.status)
    }
    if (!response.ok || 'error' in payload) {
      const message = 'error' in payload ? payload.error : `요청이 실패했습니다 (${response.status}).`
      throw new ApiError(response.status === 401 ? `인증이 거부되었습니다. ${message}` : message, response.status)
    }
    return payload.result
  }

  snapshot = (): Promise<CompanionSnapshot> => this.call('snapshot')
  saveLoop = (loop: LoopDefinition): Promise<AutomationSnapshot> => this.call('saveLoop', [loop])
  deleteLoop = (id: string): Promise<AutomationSnapshot> => this.call('deleteLoop', [id])
  approveLoop = (id: string): Promise<AutomationSnapshot> => this.call('approveLoop', [id])
  runLoop = (id: string): Promise<AutomationRun> => this.call('runLoop', [id])
  cancelRun = (id: string): Promise<void> => this.call('cancelRun', [id])
  runDetail = (id: string, after?: number): Promise<RunDetail> => this.call('runDetail', after === undefined ? [id] : [id, after])
  saveSettings = (settings: MachineSettings): Promise<AutomationSnapshot> => this.call('saveSettings', [settings])
  importOmp = (): Promise<AutomationSnapshot> => this.call('importOmp')
  skillsLocations = (): Promise<SkillLocations> => this.call('skills.locations')
  searchSkills = (query: string): Promise<SkillCandidate[]> => this.call('skills.search', [query])
  previewSkill = (source: string, skillId?: string): Promise<SkillPreview> => this.call('skills.preview', skillId === undefined ? [source] : [source, skillId])
  listSkills = (target: SkillTarget): Promise<InstalledSkill[]> => this.call('skills.list', [target])
  installSkill = (target: SkillTarget, source: string, skillId: string, revision: string): Promise<InstalledSkill> => this.call('skills.install', [target, source, skillId, revision])
  updateSkill = (target: SkillTarget, id: string, revision: string): Promise<InstalledSkill> => this.call('skills.update', [target, id, revision])
  removeSkill = (target: SkillTarget, id: string): Promise<void> => this.call('skills.remove', [target, id])
  readSurface = (workspaceId: string, surfaceId: string): Promise<{ text: string }> => this.call('cmux.read', [workspaceId, surfaceId])
  sendSurface = (workspaceId: string, surfaceId: string, text: string): Promise<void> => this.call('cmux.send', [workspaceId, surfaceId, text])
  keySurface = (workspaceId: string, surfaceId: string, key: CmuxKey): Promise<void> => this.call('cmux.key', [workspaceId, surfaceId, key])
  openRun = (runId: string): Promise<void> => this.call('cmux.openRun', [runId])
}
