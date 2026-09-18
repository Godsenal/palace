import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { MachineSettings } from '../../shared/automation'
import type { InstalledSkill, SkillCandidate, SkillPreview, SkillsAPI } from '../../shared/workbench'
import { SkillRepositoryCache, type RepositoryFile, type RepositorySkill, type RepositorySnapshot, normalizeSkillSource } from './skills-repository'

const MANIFEST_VERSION = 1
const PREVIEW_TTL_MS = 15 * 60_000

export interface SkillManifestEntry {
  id: string
  name: string
  description: string
  source: string
  revision: string
  skillPath: string
  installedAt: string
  files: Array<{ path: string; sha256: string; mode: number; bytes: number }>
}

export interface SkillRecipe {
  id: string
  source: string
  revision: string
  skillPath: string
}

export type SkillRecipes = Record<string, SkillRecipe[]>

interface StoredManifest {
  version: 1
  projects: Record<string, Record<string, SkillManifestEntry>>
}

export interface SkillsServiceOptions {
  root: string
  getSettings: () => MachineSettings
}

type TrackedInstallState = 'missing' | 'unchanged' | 'modified'

interface RecipeProjectPlan {
  aliases: string[]
  projectRoot: string
  recipes: SkillRecipe[]
  records: Record<string, SkillManifestEntry>
  states: Map<string, TrackedInstallState>
}

function sameRecipe(left: SkillRecipe | SkillManifestEntry, right: SkillRecipe): boolean {
  return left.id === right.id && left.source === right.source && left.revision === right.revision && left.skillPath === right.skillPath
}

function safeSkillPath(path: string): boolean {
  return path === '.' || path.length > 0 && path.length <= 500 && !path.startsWith('/') && !path.includes('\\') &&
    !path.includes('\0') && path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function safeId(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value) || value === '.' || value === '..') throw new Error('안전하지 않은 스킬 ID입니다.')
  return value
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function secretPath(path: string): boolean {
  const lower = path.toLowerCase()
  const name = lower.split('/').at(-1) ?? lower
  return name === '.env' || name === '.envrc' || name === '.netrc' || name.startsWith('.env.') && !name.endsWith('.example') ||
    /^(id_(rsa|dsa|ecdsa|ed25519)|credentials?(\.json)?|secrets?\.(json|ya?ml)|service-account\.json|\.npmrc|\.pypirc)$/.test(name) ||
    /\.(pem|p12|pfx|key|keystore|jks)$/.test(name) || lower.endsWith('/.docker/config.json')
}

function assertNoCredentials(file: RepositoryFile): void {
  if (secretPath(file.path)) throw new Error(`자격 증명으로 보이는 파일은 설치할 수 없습니다: ${file.path}`)
  const bytes = file.bytes ?? Buffer.alloc(0)
  if (bytes.length > 512 * 1024 || bytes.includes(0)) return
  const text = bytes.toString('utf8')
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
      /\bAKIA[0-9A-Z]{16}\b/.test(text) ||
      /\bgithub_pat_[A-Za-z0-9_]{20,}\b/.test(text) ||
      /\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(text) ||
      /\bnpm_[A-Za-z0-9]{30,}\b/.test(text)) {
    throw new Error(`비밀 자격 증명으로 보이는 내용이 있어 설치를 중단했습니다: ${file.path}`)
  }
}

function previewContent(file: RepositoryFile): string {
  const bytes = file.bytes ?? Buffer.alloc(0)
  try {
    if (bytes.includes(0)) throw new Error('binary')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return `data:application/octet-stream;base64,${bytes.toString('base64')}`
  }
}

async function assertSafeParents(projectRoot: string, target: string): Promise<void> {
  if (!isInside(projectRoot, target)) throw new Error('프로젝트 밖의 경로에는 스킬을 설치할 수 없습니다.')
  let current = projectRoot
  for (const part of relative(projectRoot, target).split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current).catch(() => null)
    if (info?.isSymbolicLink()) throw new Error(`심볼릭 링크 경로에는 스킬을 설치할 수 없습니다: ${current}`)
    if (info && !info.isDirectory()) throw new Error(`디렉터리가 아닌 경로가 설치를 막고 있습니다: ${current}`)
  }
}

async function walkInstalled(root: string, prefix = ''): Promise<Array<{ path: string; bytes: Buffer; mode: number }>> {
  const directory = join(root, prefix)
  const entries = await readdir(directory, { withFileTypes: true })
  const result: Array<{ path: string; bytes: Buffer; mode: number }> = []
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolute = join(root, ...path.split('/'))
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error(`설치된 스킬에 심볼릭 링크가 있습니다: ${path}`)
    if (info.isDirectory()) result.push(...await walkInstalled(root, path))
    else if (info.isFile()) result.push({ path, bytes: await readFile(absolute), mode: info.mode & 0o777 })
    else throw new Error(`설치된 스킬에 지원하지 않는 파일이 있습니다: ${path}`)
  }
  return result
}

export class SkillsService implements SkillsAPI {
  private readonly root: string
  private readonly getSettings: () => MachineSettings
  private readonly repositories: SkillRepositoryCache
  private readonly manifestFile: string
  private readonly recipeFile: string
  private readonly previews = new Map<string, number>()
  private manifestOperation: Promise<unknown> = Promise.resolve()

  constructor(options: SkillsServiceOptions) {
    this.root = resolve(options.root)
    this.getSettings = options.getSettings
    this.repositories = new SkillRepositoryCache(this.root)
    this.manifestFile = join(this.root, 'workbench', 'skills.json')
    this.recipeFile = join(this.root, 'workbench', 'skill-recipes.json')
  }

  async search(query: string): Promise<SkillCandidate[]> {
    if (typeof query !== 'string' || query.length > 200) throw new Error('검색어는 200자 이내로 입력하세요.')
    const value = query.trim()
    if (value.length < 2) return []
    const headers: Record<string, string> = { Accept: 'application/json' }
    const response = await fetch(`https://skills.sh/api/search?q=${encodeURIComponent(value)}&limit=50`, {
      headers,
      signal: AbortSignal.timeout(12_000)
    }).catch((error: unknown) => {
      throw new Error(`skills.sh 검색에 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (!response.ok) {
      throw new Error(`skills.sh 검색 실패 (HTTP ${response.status})`)
    }
    const payload = await response.json() as { skills?: unknown[] }
    if (!Array.isArray(payload.skills)) throw new Error('skills.sh가 예상하지 못한 응답을 반환했습니다.')
    return payload.skills.flatMap((item): SkillCandidate[] => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      const source = typeof row.source === 'string' ? row.source : ''
      const id = typeof row.skillId === 'string' ? row.skillId : ''
      if (!source || !id) return []
      return [{
        id,
        name: typeof row.name === 'string' ? row.name : id,
        description: typeof row.description === 'string' ? row.description : '',
        source,
        path: id,
        installs: typeof row.installs === 'number' ? row.installs : undefined
      }]
    })
  }

  async preview(source: string, skillId?: string): Promise<SkillPreview> {
    const snapshot = await this.repositories.snapshot(source)
    let selected: SkillPreview['selected']
    if (skillId) {
      const skill = this.select(snapshot, skillId)
      const files = await this.safeFiles(snapshot, skill)
      selected = {
        id: skill.id,
        files: files.map((file) => ({ path: file.path, content: previewContent(file) })),
        bytes: files.reduce((total, file) => total + file.size, 0)
      }
      this.previews.set(this.previewKey(snapshot.source, skill.id, snapshot.revision), Date.now() + PREVIEW_TTL_MS)
    }
    return {
      source: snapshot.source,
      revision: snapshot.revision,
      candidates: snapshot.skills.map(({ directory: _directory, manifestPath: _manifestPath, ...candidate }) => candidate),
      selected
    }
  }

  async list(project: string): Promise<InstalledSkill[]> {
    const projectRoot = await this.projectRoot(project)
    const records = await this.projectRecords(projectRoot)
    const result: InstalledSkill[] = []
    for (const record of Object.values(records)) result.push(await this.installedView(projectRoot, record))
    return result.sort((left, right) => left.name.localeCompare(right.name))
  }

  async install(project: string, source: string, skillId: string, revision: string): Promise<InstalledSkill> {
    const projectRoot = await this.projectRoot(project)
    const canonical = await normalizeSkillSource(source)
    this.requirePreview(canonical, skillId, revision)
    const snapshot = await this.repositories.snapshot(canonical, revision)
    const skill = this.select(snapshot, skillId)
    return this.installSnapshot(projectRoot, snapshot, skill, false)
  }

  async update(project: string, id: string, revision: string): Promise<InstalledSkill> {
    const projectRoot = await this.projectRoot(project)
    const records = await this.projectRecords(projectRoot)
    const current = records[safeId(id)]
    if (!current) throw new Error('Palace가 추적하는 설치 스킬이 아닙니다.')
    if ((await this.installedView(projectRoot, current)).modified) throw new Error('로컬 파일이 수정되어 업데이트하지 않았습니다. 변경을 보존하거나 되돌린 뒤 다시 시도하세요.')
    this.requirePreview(current.source, current.id, revision)
    const snapshot = await this.repositories.snapshot(current.source, revision)
    const skill = snapshot.skills.find((candidate) => candidate.directory === (current.skillPath === '.' ? '' : current.skillPath)) ?? this.select(snapshot, current.id)
    if (skill.id !== current.id) throw new Error('새 리비전에서 스킬 ID가 바뀌어 자동 업데이트하지 않았습니다.')
    return this.installSnapshot(projectRoot, snapshot, skill, true, current)
  }

  async remove(project: string, id: string): Promise<void> {
    const projectRoot = await this.projectRoot(project)
    const records = await this.projectRecords(projectRoot)
    const record = records[safeId(id)]
    if (!record) throw new Error('Palace가 추적하는 스킬만 삭제할 수 있습니다.')
    await this.removeTracked(projectRoot, record)
  }

  async manifest(project: string): Promise<SkillManifestEntry[]> {
    const projectRoot = await this.projectRoot(project)
    return Object.values(await this.projectRecords(projectRoot)).map((entry) => structuredClone(entry))
  }

  async applyManifest(project: string, entries: SkillManifestEntry[]): Promise<InstalledSkill[]> {
    const projectRoot = await this.projectRoot(project)
    const installed: InstalledSkill[] = []
    for (const requested of entries) {
      safeId(requested.id)
      const existing = (await this.projectRecords(projectRoot))[requested.id]
      if (existing) {
        const view = await this.installedView(projectRoot, existing)
        if (view.modified) throw new Error(`${requested.id}: 로컬 수정이 있어 동기화 설치를 중단했습니다.`)
        if (existing.revision === requested.revision && existing.source === requested.source) {
          installed.push(view)
          continue
        }
      }
      const snapshot = await this.repositories.snapshot(requested.source, requested.revision)
      const skill = snapshot.skills.find((candidate) => candidate.directory === (requested.skillPath === '.' ? '' : requested.skillPath))
      if (!skill || skill.id !== requested.id) throw new Error(`${requested.id}: 고정 리비전에서 같은 스킬을 찾지 못했습니다.`)
      installed.push(await this.installSnapshot(projectRoot, snapshot, skill, !!existing, existing))
    }
    return installed
  }

  async exportRecipes(): Promise<SkillRecipes> {
    const recipes = await this.readRecipes()
    for (const [alias, pending] of Object.entries(recipes)) {
      for (const entry of pending) {
        if (!entry.source.startsWith('https://github.com/')) throw new Error(`${alias}/${entry.id}: 보류 중인 로컬 스킬 레시피는 휴대할 수 없습니다.`)
      }
    }
    for (const [alias, configured] of Object.entries(this.getSettings().projectPaths)) {
      if (Object.hasOwn(recipes, alias)) continue
      const projectRoot = await realpath(resolve(configured)).catch(() => null)
      if (!projectRoot) continue
      const installed = Object.values(await this.projectRecords(projectRoot))
      for (const entry of installed) {
        if (!entry.source.startsWith('https://github.com/')) {
          throw new Error(`${alias}/${entry.id}: 로컬 저장소에서 설치한 스킬은 다른 컴퓨터로 동기화할 수 없습니다. GitHub 저장소 주소로 다시 설치하세요.`)
        }
      }
      recipes[alias] = installed.map(({ id, source, revision, skillPath }) => ({ id, source, revision, skillPath }))
    }
    return recipes
  }

  async importRecipes(recipes: SkillRecipes): Promise<void> {
    const validated: SkillRecipes = Object.create(null) as SkillRecipes
    for (const [alias, entries] of Object.entries(recipes)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(alias) || ['__proto__', 'prototype', 'constructor'].includes(alias) || !Array.isArray(entries)) {
        throw new Error('스킬 동기화 레시피의 프로젝트 별칭이 올바르지 않습니다.')
      }
      const ids = new Set<string>()
      validated[alias] = []
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') throw new Error(`${alias}: 스킬 동기화 레시피 형식이 올바르지 않습니다.`)
        safeId(entry.id)
        if (ids.has(entry.id)) throw new Error(`${alias}/${entry.id}: 같은 스킬 ID가 동기화 레시피에 중복되어 있습니다.`)
        ids.add(entry.id)
        if (typeof entry.source !== 'string' || typeof entry.revision !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(entry.revision) ||
            typeof entry.skillPath !== 'string' || !safeSkillPath(entry.skillPath)) {
          throw new Error(`${alias}/${entry.id}: 고정 리비전 또는 스킬 경로 정보가 올바르지 않습니다.`)
        }
        const source = await normalizeSkillSource(entry.source)
        if (!source.startsWith('https://github.com/')) throw new Error(`${alias}/${entry.id}: 로컬 스킬 소스는 휴대용 레시피로 가져올 수 없습니다.`)
        validated[alias].push({ id: entry.id, source, revision: entry.revision.toLowerCase(), skillPath: entry.skillPath })
      }
    }

    const settings = this.getSettings()
    const deferred = structuredClone(validated)
    for (const alias of Object.keys(settings.projectPaths)) {
      if (!Object.hasOwn(deferred, alias)) deferred[alias] = []
    }
    await this.writeRecipes(deferred)

    const plansByRoot = new Map<string, RecipeProjectPlan>()
    for (const alias of Object.keys(settings.projectPaths)) {
      const projectRoot = await this.projectRoot(alias)
      const desired = validated[alias] ?? []
      const existingPlan = plansByRoot.get(projectRoot)
      if (existingPlan) {
        const existingRecipes = JSON.stringify([...existingPlan.recipes].sort((left, right) => left.id.localeCompare(right.id)))
        const desiredRecipes = JSON.stringify([...desired].sort((left, right) => left.id.localeCompare(right.id)))
        if (existingRecipes !== desiredRecipes) {
          throw new Error(`${existingPlan.aliases[0]}와 ${alias} 별칭이 같은 프로젝트를 서로 다른 스킬 목록으로 가리킵니다.`)
        }
        existingPlan.aliases.push(alias)
        continue
      }
      plansByRoot.set(projectRoot, {
        aliases: [alias],
        projectRoot,
        recipes: desired,
        records: await this.projectRecords(projectRoot),
        states: new Map()
      })
    }

    const plans = [...plansByRoot.values()]
    for (const plan of plans) {
      const alias = plan.aliases[0]
      const desired = new Map(plan.recipes.map((recipe) => [recipe.id, recipe]))
      for (const [key, record] of Object.entries(plan.records)) {
        if (key !== record.id) throw new Error(`${alias}: 스킬 설치 기록의 ID가 일치하지 않아 안전하게 동기화할 수 없습니다.`)
        safeId(record.id)
        const state = await this.trackedInstallState(plan.projectRoot, record)
        plan.states.set(record.id, state)
        const recipe = desired.get(record.id)
        if ((!recipe || !sameRecipe(record, recipe)) && state === 'modified') {
          const action = recipe ? '교체' : '삭제'
          throw new Error(`${alias}/${record.id}: 로컬 파일이 수정되어 동기화 ${action}를 중단했습니다. 변경을 보존하거나 되돌린 뒤 다시 시도하세요.`)
        }
      }
      for (const recipe of plan.recipes) {
        if (plan.records[recipe.id]) continue
        const target = this.skillDirectory(plan.projectRoot, recipe.id)
        await assertSafeParents(plan.projectRoot, target)
        const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        if (existing) throw new Error(`${alias}/${recipe.id}: 같은 ID의 설치 경로가 있지만 Palace 설치 기록이 없어 덮어쓰지 않습니다.`)
      }
    }

    for (const plan of plans) {
      const alias = plan.aliases[0]
      for (const recipe of plan.recipes) {
        const existing = plan.records[recipe.id]
        const state = existing ? plan.states.get(recipe.id) : undefined
        if (existing && sameRecipe(existing, recipe) && state !== 'missing') continue
        const snapshot = await this.repositories.snapshot(recipe.source, recipe.revision)
        const directory = recipe.skillPath === '.' ? '' : recipe.skillPath
        const skill = snapshot.skills.find((candidate) => candidate.id === recipe.id && candidate.directory === directory)
        if (!skill) throw new Error(`${alias}/${recipe.id}: 고정 리비전에서 같은 스킬을 찾지 못했습니다.`)
        await this.installSnapshot(plan.projectRoot, snapshot, skill, !!existing, existing, `${alias}/${recipe.id}`, state)
      }
    }

    for (const plan of plans) {
      const desired = new Set(plan.recipes.map((recipe) => recipe.id))
      for (const record of Object.values(plan.records)) {
        if (!desired.has(record.id)) {
          await this.removeTracked(plan.projectRoot, record, `${plan.aliases[0]}/${record.id}`, plan.states.get(record.id))
        }
      }
      for (const alias of plan.aliases) delete deferred[alias]
    }
    await this.writeRecipes(deferred)
  }

  private previewKey(source: string, id: string, revision: string): string {
    return `${source}\0${id}\0${revision.toLowerCase()}`
  }

  private requirePreview(source: string, id: string, revision: string): void {
    const key = this.previewKey(source, safeId(id), revision)
    const expires = this.previews.get(key) ?? 0
    this.previews.delete(key)
    if (expires < Date.now()) throw new Error('이 리비전을 먼저 미리보기한 뒤 설치하거나 업데이트하세요.')
  }

  private select(snapshot: RepositorySnapshot, id: string): RepositorySkill {
    const safe = safeId(id)
    const skill = snapshot.skills.find((candidate) => candidate.id === safe)
    if (!skill) throw new Error(`저장소에서 스킬을 찾지 못했습니다: ${safe}`)
    return skill
  }

  private async safeFiles(snapshot: RepositorySnapshot, skill: RepositorySkill): Promise<RepositoryFile[]> {
    const files = await this.repositories.files(snapshot, skill)
    for (const file of files) {
      assertNoCredentials(file)
      const text = file.bytes?.subarray(0, 160).toString('utf8') ?? ''
      if (text.startsWith('version https://git-lfs.github.com/spec/v1')) {
        throw new Error(`Git LFS 자산은 자동으로 내려받지 않습니다. 저장소에 실제 파일을 포함한 뒤 다시 시도하세요: ${file.path}`)
      }
    }
    return files
  }

  private async projectRoot(project: string): Promise<string> {
    const paths = this.getSettings().projectPaths
    const configured = paths[project] ?? Object.values(paths).find((path) => resolve(path) === resolve(project))
    if (!configured) throw new Error('등록된 프로젝트에만 스킬을 설치할 수 있습니다.')
    const root = await realpath(resolve(configured)).catch(() => null)
    if (!root) throw new Error('등록된 프로젝트 경로가 존재하지 않습니다.')
    const info = await lstat(root)
    if (!info.isDirectory()) throw new Error('등록된 프로젝트 경로가 디렉터리가 아닙니다.')
    return root
  }

  private skillDirectory(projectRoot: string, id: string): string {
    return join(projectRoot, '.agent', 'skills', safeId(id))
  }

  private async trackedInstallState(projectRoot: string, record: SkillManifestEntry): Promise<TrackedInstallState> {
    const target = this.skillDirectory(projectRoot, record.id)
    await assertSafeParents(projectRoot, dirname(target))
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) return 'missing'
    if (info.isSymbolicLink() || !info.isDirectory()) return 'modified'
    try {
      const actual = await walkInstalled(target)
      const expected = new Map(record.files.map((file) => [file.path, file]))
      if (actual.length !== record.files.length || actual.some((file) => {
        const tracked = expected.get(file.path)
        return !tracked || tracked.sha256 !== sha256(file.bytes) || tracked.mode !== file.mode
      })) return 'modified'
      return 'unchanged'
    } catch {
      return 'modified'
    }
  }

  private async installedView(projectRoot: string, record: SkillManifestEntry): Promise<InstalledSkill> {
    const target = this.skillDirectory(projectRoot, record.id)
    const modified = await this.trackedInstallState(projectRoot, record).then((state) => state !== 'unchanged').catch(() => true)
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      source: record.source,
      revision: record.revision,
      installedAt: record.installedAt,
      modified,
      path: target
    }
  }

  private async removeTracked(
    projectRoot: string,
    record: SkillManifestEntry,
    conflictLabel?: string,
    preflightState?: TrackedInstallState
  ): Promise<void> {
    const target = this.skillDirectory(projectRoot, record.id)
    let expectedMissing = false
    if (conflictLabel) {
      const state = await this.trackedInstallState(projectRoot, record)
      if (preflightState === 'missing' && state !== 'missing') {
        throw new Error(`${conflictLabel}: 비어 있던 설치 경로에 다른 디렉터리가 생겨 삭제하지 않았습니다.`)
      }
      if (state === 'modified') {
        throw new Error(`${conflictLabel}: 로컬 파일이 수정되어 동기화 삭제를 중단했습니다. 변경을 보존하거나 되돌린 뒤 다시 시도하세요.`)
      }
      expectedMissing = state === 'missing'
    }
    await assertSafeParents(projectRoot, target)
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (expectedMissing && info) throw new Error(`${conflictLabel}: 비어 있던 설치 경로에 다른 디렉터리가 생겨 삭제하지 않았습니다.`)
    if (info?.isSymbolicLink()) throw new Error('심볼릭 링크인 스킬 디렉터리는 삭제하지 않습니다.')
    if (info) await rm(target, { recursive: true, force: false })
    await this.changeManifest((manifest) => {
      if (manifest.projects[projectRoot]) delete manifest.projects[projectRoot][record.id]
    })
  }

  private async installSnapshot(
    projectRoot: string,
    snapshot: RepositorySnapshot,
    skill: RepositorySkill,
    replacing: boolean,
    trackedRecord?: SkillManifestEntry,
    conflictLabel?: string,
    preflightState?: TrackedInstallState
  ): Promise<InstalledSkill> {
    const files = await this.safeFiles(snapshot, skill)
    const skillsRoot = join(projectRoot, '.agent', 'skills')
    const target = this.skillDirectory(projectRoot, skill.id)
    const trackedState = trackedRecord ? await this.trackedInstallState(projectRoot, trackedRecord) : undefined
    if (preflightState === 'missing' && trackedState !== 'missing') {
      throw new Error(`${conflictLabel ?? skill.id}: 비어 있던 설치 경로에 다른 디렉터리가 생겨 덮어쓰지 않습니다.`)
    }
    if (trackedState === 'modified') {
      throw new Error(`${conflictLabel ?? skill.id}: 로컬 파일이 수정되어 동기화 교체를 중단했습니다. 변경을 보존하거나 되돌린 뒤 다시 시도하세요.`)
    }
    await assertSafeParents(projectRoot, skillsRoot)
    await mkdir(skillsRoot, { recursive: true, mode: 0o755 })
    await assertSafeParents(projectRoot, target)
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (trackedState === 'missing' && existing) throw new Error(`${conflictLabel ?? skill.id}: 비어 있던 설치 경로에 다른 디렉터리가 생겨 덮어쓰지 않습니다.`)
    if (existing && !replacing) throw new Error('같은 ID의 디렉터리가 이미 있습니다. 추적되지 않은 파일은 덮어쓰지 않습니다.')
    if (existing?.isSymbolicLink() || existing && !existing.isDirectory()) throw new Error('안전하지 않은 기존 설치 경로입니다.')

    const nonce = randomBytes(8).toString('hex')
    const temporary = join(skillsRoot, `.palace-install-${nonce}`)
    const backup = join(skillsRoot, `.palace-backup-${nonce}`)
    const tracked: SkillManifestEntry['files'] = []
    try {
      await mkdir(temporary, { recursive: false, mode: 0o700 })
      for (const file of files) {
        const destination = join(temporary, ...file.path.split('/'))
        if (!isInside(temporary, destination)) throw new Error(`안전하지 않은 파일 경로입니다: ${file.path}`)
        await mkdir(dirname(destination), { recursive: true, mode: 0o755 })
        const bytes = file.bytes ?? Buffer.alloc(0)
        const mode = file.mode === '100755' ? 0o755 : 0o644
        await writeFile(destination, bytes, { mode, flag: 'wx' })
        tracked.push({ path: file.path, sha256: sha256(bytes), mode, bytes: bytes.length })
      }
      await assertSafeParents(projectRoot, target)
      const finalExisting = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (existing ? !finalExisting || existing.dev !== finalExisting.dev || existing.ino !== finalExisting.ino : finalExisting) {
        throw new Error(`${conflictLabel ?? skill.id}: 설치 중 대상 경로가 변경되어 덮어쓰지 않습니다.`)
      }
      if (trackedRecord && await this.trackedInstallState(projectRoot, trackedRecord) !== trackedState) {
        throw new Error(`${conflictLabel ?? skill.id}: 설치 중 로컬 파일이 수정되어 덮어쓰지 않습니다.`)
      }
      if (existing) await rename(target, backup)
      try {
        await rename(temporary, target)
      } catch (error) {
        if (existing) await rename(backup, target)
        throw error
      }
      const record: SkillManifestEntry = {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        source: snapshot.source,
        revision: snapshot.revision,
        skillPath: skill.directory || '.',
        installedAt: new Date().toISOString(),
        files: tracked
      }
      try {
        await this.changeManifest((manifest) => {
          manifest.projects[projectRoot] ??= {}
          manifest.projects[projectRoot][record.id] = record
        })
      } catch (error) {
        await rm(target, { recursive: true, force: true })
        if (existing) await rename(backup, target)
        throw error
      }
      if (existing) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
      return this.installedView(projectRoot, record)
    } finally {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async readManifest(): Promise<StoredManifest> {
    try {
      const parsed = JSON.parse(await readFile(this.manifestFile, 'utf8')) as StoredManifest
      if (parsed.version === MANIFEST_VERSION && parsed.projects && typeof parsed.projects === 'object') return parsed
      throw new Error('version')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: MANIFEST_VERSION, projects: {} }
      throw new Error('스킬 설치 기록이 손상되어 안전하게 계속할 수 없습니다.')
    }
  }

  private async projectRecords(projectRoot: string): Promise<Record<string, SkillManifestEntry>> {
    return (await this.readManifest()).projects[projectRoot] ?? {}
  }

  private async readRecipes(): Promise<SkillRecipes> {
    try {
      const parsed = JSON.parse(await readFile(this.recipeFile, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape')
      return parsed as SkillRecipes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error('보류 중인 스킬 동기화 레시피가 손상되었습니다.')
    }
  }

  private async writeRecipes(recipes: SkillRecipes): Promise<void> {
    await mkdir(dirname(this.recipeFile), { recursive: true, mode: 0o700 })
    const temporary = `${this.recipeFile}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(recipes, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.recipeFile)
  }

  private async changeManifest(change: (manifest: StoredManifest) => void): Promise<void> {
    const operation = this.manifestOperation.then(async () => {
      const manifest = await this.readManifest()
      change(manifest)
      await mkdir(dirname(this.manifestFile), { recursive: true, mode: 0o700 })
      const temporary = `${this.manifestFile}.${randomBytes(6).toString('hex')}.tmp`
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
      await chmod(temporary, 0o600)
      await rename(temporary, this.manifestFile)
    })
    this.manifestOperation = operation.catch(() => undefined)
    await operation
  }
}
