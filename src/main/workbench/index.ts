import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AutomationSnapshot, PortableProfile } from '../../shared/automation'
import { WORKBENCH_METHODS } from '../../shared/workbench'
import type { AutomationService } from '../automation/service'
import { writePrivateAtomic } from '../automation/store'
import { OmpService } from './omp'
import { SkillsService } from './skills'
import { LoopsEngineHost } from './loopsEngine'
import { NativeOmpRemoteService } from './remote'
import { SetupService } from './setup'


export class Workbench {
  readonly omp: OmpService
  readonly skills: SkillsService
  readonly loops: LoopsEngineHost
  readonly remote: NativeOmpRemoteService
  readonly setup: SetupService
  private capturing?: Promise<void>
  private applying?: Promise<void>
  private portableQueue: Promise<unknown> = Promise.resolve()
  private pendingApply = false
  private syncWarning?: string
  private readonly applyPath: string

  constructor(private readonly core: AutomationService, root: string, private readonly automation: (method: string, args: unknown[]) => Promise<unknown>) {
    this.applyPath = join(root, 'workbench', 'apply-pending.json')
    const callbacks = { root, getSettings: () => core.getSettings(), getOmp: () => core.getProfile().omp }
    this.omp = new OmpService(callbacks)
    this.skills = new SkillsService(callbacks)
    const engineSource = process.env.PALACE_OMP_ENGINE_SOURCE || join(__dirname, '../../engines/loops')
    this.loops = new LoopsEngineHost({ ...callbacks, source: engineSource })
    this.setup = new SetupService(callbacks)
    this.remote = new NativeOmpRemoteService({ ...callbacks, getProfiles: () => this.omp.profiles(), engineSource })
  }

  async initialize(): Promise<void> {
    await this.omp.initialize()
    try {
      const checkpoint = JSON.parse(readFileSync(this.applyPath, 'utf8'))
      if (checkpoint?.pending !== true && checkpoint?.pending !== false) throw new Error('잘못된 적용 상태 파일입니다')
      this.pendingApply = checkpoint.pending
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.pendingApply = true
        this.syncWarning = `동기화 적용 상태를 읽지 못했습니다: ${this.errorText(error)}`
      }
    }
    if (this.pendingApply) {
      try { await this.applyPortable() } catch (error) { this.syncWarning = this.errorText(error) }
    }
  }

  async capturePortable(): Promise<void> {
    if (this.pendingApply) throw new Error(this.syncWarning || '가져온 프로필 적용이 보류 중입니다. 프로젝트 경로와 로컬 충돌을 해결한 뒤 가져오기를 다시 실행하세요.')
    if (this.capturing) return this.capturing
    this.capturing = (async () => {
      const previous = this.core.getProfile().workbench
      const [profiles, recipes, engine] = await Promise.all([this.omp.profiles(), this.skills.exportRecipes(), this.loops.exportPortable()])
      // 아직 경로를 연결하지 않은 다른 머신의 레시피는 지우지 않는다.
      const skills = { ...previous?.skills, ...recipes }
      const meaningful = profiles.length > 0 || Object.values(skills).some((entries) => entries.length > 0) || Object.keys(engine.loops).length > 0 || Object.keys(engine.products).length > 0
      if (!previous && !meaningful) { this.syncWarning = undefined; return }
      const next: NonNullable<PortableProfile['workbench']> = { profiles, skills, engine }
      if (JSON.stringify(previous) !== JSON.stringify(next)) await this.core.saveWorkbench(next)
      this.syncWarning = undefined
    })().finally(() => { this.capturing = undefined })
    return this.capturing
  }

  async applyPortable(): Promise<void> {
    if (this.applying) return this.applying
    this.setPending(true)
    this.applying = (async () => {
      const profile = this.core.getProfile().workbench
      await this.omp.saveProfiles(profile?.profiles ?? [])
      await this.skills.importRecipes(profile?.skills ?? {})
      await this.loops.importPortable(profile?.engine ?? { loops: {}, products: {} })
      this.setPending(false)
      this.syncWarning = undefined
    })().catch((error) => {
      this.syncWarning = `가져온 프로필 적용 보류: ${this.errorText(error)}. 원인을 해결한 뒤 가져오기를 다시 실행하세요.`
      throw new Error(this.syncWarning)
    }).finally(() => { this.applying = undefined })
    return this.applying
  }

  private setPending(pending: boolean): void {
    writePrivateAtomic(this.applyPath, { pending })
    this.pendingApply = pending
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private withSyncWarning(snapshot: AutomationSnapshot): AutomationSnapshot {
    if (this.pendingApply || this.syncWarning) {
      snapshot.sync = { ...snapshot.sync, dirty: true, message: this.syncWarning || '가져온 프로필 적용이 보류 중입니다.' }
    }
    return snapshot
  }

  async dispatch(method: string, args: unknown[]): Promise<unknown> {
    if (typeof method !== 'string' || !Array.isArray(args) || args.length > 10) throw new Error('잘못된 워크벤치 요청입니다')
    const name = method.startsWith('automation.') ? method.slice(11) : method
    const portable = ['snapshot', 'sync', 'saveSettings', 'omp.saveProfiles', 'skills.install', 'skills.update', 'skills.remove'].includes(name) || (method === 'loops.request' && args[1] === 'POST')
    if (!portable) return this.dispatchCurrent(method, args)
    const operation = this.portableQueue.then(() => this.dispatchCurrent(method, args))
    this.portableQueue = operation.catch(() => undefined)
    return operation
  }

  private async dispatchCurrent(method: string, args: unknown[]): Promise<unknown> {
    if (!method.includes('.') || method.startsWith('automation.')) {
      const name = method.startsWith('automation.') ? method.slice(11) : method
      if (name === 'snapshot') {
        try { await this.capturePortable() } catch (error) { this.syncWarning = this.errorText(error) }
        return this.withSyncWarning(await this.core.snapshot())
      }
      if (name === 'sync') {
        if (this.pendingApply && args[0] === 'pull') await this.applyPortable()
        await this.capturePortable()
      }
      if (name === 'saveSettings' && !this.pendingApply) await this.capturePortable()
      const apply = (name === 'sync' && args[0] === 'pull') || name === 'saveSettings'
      if (apply) this.setPending(true)
      const result = await this.automation(name, args)
      if (apply) {
        try { await this.applyPortable() } catch (error) {
          if (name === 'sync') throw error
        }
        return this.withSyncWarning(await this.core.snapshot())
      }
      return result
    }
    const [namespace, name, extra] = method.split('.')
    if (extra || !Object.hasOwn(WORKBENCH_METHODS, namespace) || !WORKBENCH_METHODS[namespace].includes(name)) throw new Error('지원하지 않는 워크벤치 메서드입니다')
    const services = { omp: this.omp, skills: this.skills, loops: this.loops, remote: this.remote, setup: this.setup }
    const service = services[namespace as keyof typeof services]
    const fn = (service as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]
    const skillMutation = ['skills.install', 'skills.update', 'skills.remove'].includes(method)
    const skillTarget = skillMutation && args[0] && typeof args[0] === 'object' ? args[0] as Record<string, unknown> : undefined
    const projectReference = skillTarget?.scope === 'project' && typeof skillTarget.project === 'string' ? skillTarget.project : undefined
    const projectSkillMutation = projectReference !== undefined
    const portableMutation = method === 'omp.saveProfiles' || projectSkillMutation || (method === 'loops.request' && args[1] === 'POST')
    if (this.pendingApply && portableMutation) {
      const projectAlias = projectReference && (
        Object.hasOwn(this.core.getSettings().projectPaths, projectReference)
          ? projectReference
          : Object.entries(this.core.getSettings().projectPaths).find(([, path]) => resolve(path) === resolve(projectReference))?.[0]
      )
      const desiredSkills = projectAlias ? this.core.getProfile().workbench?.skills?.[projectAlias] ?? [] : []
      const resolvesRemoval = projectSkillMutation && method === 'skills.remove' && !desiredSkills.some((entry) => entry.id === args[1])
      const action = method === 'loops.request' && args[2] && typeof args[2] === 'object' ? (args[2] as Record<string, unknown>).action : undefined
      const runtimeAction = typeof action === 'string' && ['stop', 'pause', 'resume', 'loop-pause', 'loop-resume', 'toggle-enabled', 'resolve-gate', 'close-tab'].includes(action)
      if (!resolvesRemoval && !runtimeAction) await this.applyPortable()
    }
    const result = await Reflect.apply(fn, service, args)
    if (portableMutation) {
      try {
        if (this.pendingApply) await this.applyPortable()
        else await this.capturePortable()
      } catch (error) { this.syncWarning = this.errorText(error) }
    }
    return result
  }

  async shutdown(): Promise<void> {
    await this.loops.stop()
  }
}
