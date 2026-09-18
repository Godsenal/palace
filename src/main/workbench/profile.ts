import type { PortableProfile } from '../../shared/automation'
import type { AgentProfile } from '../../shared/workbench'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SECRET_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|credentials|env)$/i
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}는 객체여야 합니다`)
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`${label} 값이 올바르지 않습니다`)
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{24,}/.test(value)) throw new Error(`${label}에 인증 정보가 포함되어 있습니다`)
  return value
}
function id(value: unknown, label: string, max = 64): string {
  const result = text(value, label, max)
  if (!SAFE_ID.test(result) || result === '__proto__' || result === 'constructor' || result === 'prototype') throw new Error(`${label} 식별자가 안전하지 않습니다`)
  return result
}
function portable(value: unknown, label: string, depth = 0): void {
  if (depth > 16) throw new Error(`${label} 중첩이 너무 깊습니다`)
  if (typeof value === 'string') {
    text(value, label)
    if (/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(value)) throw new Error(`${label}의 머신 절대 경로는 동기화할 수 없습니다`)
    if (/^https?:\/\/[^/]*@/.test(value)) throw new Error(`${label}에 자격 정보가 포함된 URL은 사용할 수 없습니다`)
    if (/^https?:\/\//.test(value) && !/Regex$/i.test(label)) { const url = new URL(value); if (url.username || url.password || url.search) throw new Error(`${label}에 자격 정보가 포함된 URL은 사용할 수 없습니다`) }
  } else if (Array.isArray(value)) { for (const entry of value) portable(entry, label, depth + 1) }
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`${label}.${key}는 동기화할 수 없습니다`)
      portable(entry, `${label}.${key}`, depth + 1)
    }
  } else if (value !== null && typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${label}에 JSON이 아닌 값이 있습니다`)
}

export function validateAgentProfiles(value: unknown): AgentProfile[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error('에이전트 프로필은 최대 64개입니다')
  const ids: Record<string, true> = Object.create(null)
  return value.map((value) => {
    const row = object(value, 'profile')
    const profileId = id(row.id, 'profile.id')
    if (ids[profileId]) throw new Error('에이전트 프로필 ID가 중복됩니다')
    ids[profileId] = true
    const rawModel = text(row.model, 'profile.model', 200).trim()
    const model = !rawModel || rawModel.toLowerCase() === 'auto' ? 'auto' : rawModel
    if (/\s/.test(model)) throw new Error('프로필 모델이 올바르지 않습니다')
    const thinking = text(row.thinking, 'profile.thinking', 30).trim().toLowerCase() || 'auto'
    if (!['auto','off','minimal','low','medium','high','xhigh','max'].includes(thinking)) throw new Error('지원하지 않는 추론 수준입니다')
    const name = text(row.name, 'profile.name', 120).trim()
    if (!name) throw new Error('프로필 이름이 비어 있습니다')
    return { id: profileId, name, model, thinking, instructions: text(row.instructions, 'profile.instructions'), whenToUse: text(row.whenToUse, 'profile.whenToUse', 10_000) }
  })
}

export function validateWorkbench(value: unknown): NonNullable<PortableProfile['workbench']> {
  const input = object(value, 'workbench')
  if (Object.keys(input).some((key) => !['profiles', 'skills', 'engine'].includes(key))) throw new Error('알 수 없는 workbench 필드가 있습니다')
  const profiles = validateAgentProfiles(input.profiles)
  const skills: NonNullable<PortableProfile['workbench']>['skills'] = {}
  for (const [project, entries] of Object.entries(object(input.skills, 'workbench.skills'))) {
    id(project, 'project')
    if (!Array.isArray(entries) || entries.length > 128) throw new Error('프로젝트 스킬 목록이 올바르지 않습니다')
    const names = new Set<string>()
    skills[project] = entries.map((entry) => {
      const row = object(entry, 'skill')
      const skillId = id(row.id, 'skill.id', 80)
      if (names.has(skillId)) throw new Error('동기화 스킬 ID가 중복됩니다')
      names.add(skillId)
      const source = text(row.source, 'skill.source', 2000)
      if (!/^(?:https:\/\/[^\s]+|git@github\.com:[^\s]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.test(source)) throw new Error('로컬 경로의 스킬은 원격 동기화 레시피로 저장할 수 없습니다')
      portable(source, 'skill.source')
      const revision = text(row.revision, 'skill.revision', 64)
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision)) throw new Error('스킬은 정확한 Git 커밋으로 고정해야 합니다')
      const skillPath = text(row.skillPath, 'skill.skillPath', 500)
      if (skillPath.startsWith('/') || skillPath.includes('\\') || skillPath.split('/').some((part) => part === '..')) throw new Error('스킬 저장소 경로가 안전하지 않습니다')
      return { id: skillId, source, revision, skillPath }
    })
  }
  const result: NonNullable<PortableProfile['workbench']> = { profiles, skills }
  if (input.engine !== undefined) {
    const engine = object(input.engine, 'workbench.engine')
    const loops: NonNullable<typeof result.engine>['loops'] = {}
    const products: NonNullable<typeof result.engine>['products'] = {}
    for (const [key, value] of Object.entries(object(engine.loops, 'engine.loops'))) {
      id(key, 'loop.id', 128)
      const row = object(value, 'engine.loop')
      const config = object(row.config, 'engine.loop.config')
      portable(config, 'engine.loop.config')
      const mission = text(row.mission, 'engine.loop.mission')
      const vision = row.vision === undefined ? undefined : text(row.vision, 'engine.loop.vision')
      loops[key] = { config: structuredClone(config), mission, ...(vision === undefined ? {} : { vision }) }
    }
    for (const [key, value] of Object.entries(object(engine.products, 'engine.products'))) {
      id(key, 'product.id', 128); portable(value, 'engine.product'); products[key] = structuredClone(object(value, 'engine.product'))
    }
    result.engine = { loops, products }
  }
  return result
}
