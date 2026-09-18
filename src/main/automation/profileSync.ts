import { isUtf8 } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'
import { runCapture } from '../exec'
import type { LoopDefinition, PortableProfile, SyncStatus, Trigger } from '../../shared/automation'
import type { SyncOptions } from './contracts'
import { nextCronFire } from './triggers'
import { validateWorkbench } from '../workbench/profile'

const PROFILE_FILE = 'palace-profile.json'
const BASELINE_FILE = 'sync-baselines.json'
const MAX_BASELINE_BYTES = 256 * 1024
const MAX_PROFILE_BYTES = 5 * 1024 * 1024
const MAX_CONFIG_BYTES = 512 * 1024
const MAX_INSTRUCTIONS_BYTES = 512 * 1024
const MAX_SKILL_FILE_BYTES = 256 * 1024
const MAX_SKILL_BYTES = 3 * 1024 * 1024
const MAX_SKILL_FILES = 256
const MAX_JSON_DEPTH = 32
const SYNC_LIMITS =
  'OMP 인증, 머신 경로, 승인 정책, 실행 확장, 환경 변수와 사용자 지정 URL은 동기화하지 않습니다.'

const PORTABLE_CONFIG_KEYS: Record<string, true> = {
  modelRoles: true,
  modelRoleStorage: true,
  modelTags: true,
  modelProviderOrder: true,
  cycleOrder: true,
  enabledModels: true,
  enabledProviders: true,
  disabledProviders: true,
  includeModelInPrompt: true,
  defaultThinkingLevel: true,
  hideThinkingBlock: true,
  thinking: true,
  thinkingBudgets: true,
  proseOnlyThinking: true,
  omitThinking: true,
  externalThinking: true,
  temperature: true,
  topP: true,
  topK: true,
  minP: true,
  presencePenalty: true,
  repetitionPenalty: true,
  textVerbosity: true,
  tier: true,
  personality: true,
  retry: true,
  advisor: true,
  task: true,
  prewalk: true,
  compaction: true,
  extendedContext: true,
  contextPromotion: true,
  theme: true,
  symbolPreset: true,
  composer: true,
  colorBlindMode: true,
  showHardwareCursor: true,
  statusLine: true,
  terminal: true,
  images: true,
  tui: true,
  display: true,
  steeringMode: true,
  followUpMode: true,
  interruptMode: true,
  doubleEscapeAction: true,
  autoResume: true,
  plan: true,
  ask: true,
  edit: true,
  read: true,
  readLineNumbers: true,
  includeWorkspaceTree: true,
  autocompleteMaxVisible: true,
  emojiAutocomplete: true,
  inlineToolDescriptors: true,
  treeFilterMode: true,
  setupVersion: true,
  providers: true
}

// Provider selection and transport preferences are portable. Endpoints, auth and custom
// provider definitions are deliberately not.
const PORTABLE_PROVIDER_KEYS: Record<string, true> = {
  webSearchOrder: true,
  webSearchExclude: true,
  webSearchTimeoutSeconds: true,
  webSearchGeminiModel: true,
  imageOrder: true,
  fetch: true,
  judgmentProvider: true,
  tinyModel: true,
  tinyModelDevice: true,
  tinyModelDtype: true,
  openaiWebsockets: true,
  openrouterVariant: true,
  kimiApiFormat: true,
  cacheRetention: true,
  maxInFlightRequests: true,
  autoThinkingMaxEffort: true
}

const FORBIDDEN_CONFIG_KEY =
  /(?:^|[_-])(api[_-]?key|access[_-]?key|secrets?|tokens?|access[_-]?tokens?|password|passwd|credentials?|private[_-]?key|auth|cookie|session|endpoint|base[_-]?url|url|proxy|env|environment|path|command|hook|extension|mcp|server|shell|interceptor|handler|approval|trust)(?:$|[_-])/i
const SECRET_FILE = /(?:^|[._-])(env|secret|credentials?|tokens?|password|private|id_rsa|id_ed25519)(?:$|[._-])/i
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SAFE_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function fail(message: string): never {
  throw new Error(`프로필 동기화: ${message}`)
}
function statusError(error: unknown): string {
  return `${error instanceof Error ? error.message : String(error)} ${SYNC_LIMITS}`
}

function jsonObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${path}는 객체여야 합니다`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(`${path}에는 일반 JSON 객체만 사용할 수 있습니다`)
  return value as Record<string, unknown>
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allow = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) fail(`${path}.${key} 필드는 지원하지 않습니다`)
  }
}

function text(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string') fail(`${path}는 문자열이어야 합니다`)
  if (value.length < min || Buffer.byteLength(value, 'utf8') > max || value.includes('\0')) {
    fail(`${path}의 길이가 허용 범위를 벗어났습니다`)
  }
  return value
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${path}는 ${min}~${max} 범위의 정수여야 합니다`)
  }
  return value as number
}

function assertFiniteJson(value: unknown, path: string, depth = 0, seen = new Set<object>()): void {
  if (depth > MAX_JSON_DEPTH) fail(`${path}의 중첩이 너무 깊습니다`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path}에 유한하지 않은 숫자가 있습니다`)
    return
  }
  if (typeof value !== 'object') fail(`${path}에 JSON으로 저장할 수 없는 값이 있습니다`)
  if (seen.has(value)) fail(`${path}에 순환 참조가 있습니다`)
  seen.add(value)
  if (Array.isArray(value)) {
    if (value.length > 4096 || Reflect.ownKeys(value).length !== value.length + 1) {
      fail(`${path} 배열이 너무 크거나 JSON 배열 형식이 아닙니다`)
    }
    for (let index = 0; index < value.length; index += 1) {
      assertFiniteJson(value[index], `${path}[${index}]`, depth + 1, seen)
    }
  } else {
    const object = jsonObject(value, path)
    const keys = Reflect.ownKeys(object)
    if (keys.length > 4096) fail(`${path} 객체가 너무 큽니다`)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key)
      if (
        typeof key !== 'string' ||
        !key ||
        key.length > 256 ||
        key.includes('\0') ||
        key === '__proto__' ||
        key === 'prototype' ||
        key === 'constructor' ||
        !descriptor?.enumerable ||
        !('value' in descriptor)
      ) {
        fail(`${path}에 잘못된 키가 있습니다`)
      }
      assertFiniteJson(descriptor.value, `${path}.${key}`, depth + 1, seen)
    }
  }
  seen.delete(value)
}

function hasObviousSecret(value: string): boolean {
  return (
    /-----BEGIN (?:(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/.test(value) ||
    /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{20,}|gh[opurs]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/.test(
      value
    ) ||
    /\bAIza[0-9A-Za-z_-]{30,}\b/.test(value) ||
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(value) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i.test(value) ||
    /(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i.test(value)
  )
}

function assertNoSecret(value: string, path: string): void {
  if (hasObviousSecret(value)) fail(`${path}에서 API 토큰 또는 개인 키로 보이는 값을 발견했습니다`)
}

function assertPortableConfigNode(value: unknown, path: string, key = ''): void {
  assertFiniteJson(value, path)
  const visit = (node: unknown, current: string, field: string, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) fail(`${current}의 중첩이 너무 깊습니다`)
    if (field && FORBIDDEN_CONFIG_KEY.test(field)) fail(`${current}는 머신 전용 또는 보안 설정입니다`)
    if (typeof node === 'string') {
      assertNoSecret(node, current)
      if (/\b[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(node) || /(?:^|\s)(?:~\/|\.{0,2}\/|\/[A-Za-z]|[A-Za-z]:[\\/])/.test(node)) {
        fail(`${current}에는 URL 또는 머신 경로를 넣을 수 없습니다`)
      }
      if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%/.test(node)) {
        fail(`${current}에는 환경 변수 참조를 넣을 수 없습니다`)
      }
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${current}[${index}]`, '', depth + 1))
    } else if (node !== null && typeof node === 'object') {
      for (const [childKey, child] of Object.entries(jsonObject(node, current))) {
        visit(child, `${current}.${childKey}`, childKey, depth + 1)
      }
    }
  }
  visit(value, path, key, 0)
}

function validateConfig(value: unknown): Record<string, unknown> {
  const source = jsonObject(value, 'omp.config')
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (!Object.hasOwn(PORTABLE_CONFIG_KEYS, key)) {
      fail(`omp.config.${key}는 휴대 가능한 설정이 아닙니다`)
    }
    if (key === 'providers') {
      const providerSource = jsonObject(item, 'omp.config.providers')
      const providers: Record<string, unknown> = {}
      for (const [providerKey, providerValue] of Object.entries(providerSource)) {
        if (!Object.hasOwn(PORTABLE_PROVIDER_KEYS, providerKey)) {
          fail(`omp.config.providers.${providerKey}는 휴대 가능한 설정이 아닙니다`)
        }
        assertPortableConfigNode(providerValue, `omp.config.providers.${providerKey}`, providerKey)
        providers[providerKey] = providerValue
      }
      result[key] = providers
      continue
    }
    assertPortableConfigNode(item, `omp.config.${key}`, key)
    result[key] = item
  }
  const size = Buffer.byteLength(JSON.stringify(result), 'utf8')
  if (size > MAX_CONFIG_BYTES) fail('omp.config가 너무 큽니다')
  return result
}

function validateTrigger(value: unknown, path: string): Trigger {
  const trigger = jsonObject(value, path)
  if (typeof trigger.kind !== 'string') fail(`${path}.kind가 올바르지 않습니다`)
  switch (trigger.kind) {
    case 'manual':
    case 'webhook':
      assertExactKeys(trigger, ['kind'], path)
      return { kind: trigger.kind }
    case 'interval':
      assertExactKeys(trigger, ['kind', 'seconds'], path)
      return { kind: 'interval', seconds: integer(trigger.seconds, `${path}.seconds`, 10, 604_800) }
    case 'daily': {
      assertExactKeys(trigger, ['kind', 'time', 'timezone'], path)
      const time = text(trigger.time, `${path}.time`, 5, 5)
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) fail(`${path}.time은 HH:MM 형식이어야 합니다`)
      const timezone = text(trigger.timezone, `${path}.timezone`, 1, 100)
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
      } catch {
        fail(`${path}.timezone을 인식할 수 없습니다`)
      }
      return { kind: 'daily', time, timezone }
    }
    case 'cron': {
      assertExactKeys(trigger, ['kind', 'expression', 'timezone'], path)
      const expression = text(trigger.expression, `${path}.expression`, 1, 120)
      const timezone = text(trigger.timezone, `${path}.timezone`, 1, 100)
      nextCronFire(new Date(), expression, timezone)
      return { kind: 'cron', expression, timezone }
    }
    case 'github': {
      assertExactKeys(trigger, ['kind', 'repository', 'event', 'pollSeconds'], path)
      const repository = text(trigger.repository, `${path}.repository`, 3, 200)
      if (!SAFE_REPOSITORY.test(repository) || repository.includes('..')) {
        fail(`${path}.repository는 owner/repo 형식이어야 합니다`)
      }
      if (!['issue_opened', 'pull_request_review', 'workflow_failed'].includes(String(trigger.event))) {
        fail(`${path}.event가 올바르지 않습니다`)
      }
      return {
        kind: 'github',
        repository,
        event: trigger.event as 'issue_opened' | 'pull_request_review' | 'workflow_failed',
        pollSeconds: integer(trigger.pollSeconds, `${path}.pollSeconds`, 30, 3600)
      }
    }
    default:
      fail(`${path}.kind가 올바르지 않습니다`)
  }
}

function validateLoop(value: unknown, index: number): LoopDefinition {
  const path = `loops[${index}]`
  const loop = jsonObject(value, path)
  assertExactKeys(
    loop,
    ['id', 'name', 'project', 'mission', 'trigger', 'model', 'checks', 'maxAttempts', 'timeoutMinutes', 'enabled'],
    path
  )
  const id = text(loop.id, `${path}.id`, 1, 64)
  if (
    !SAFE_ID.test(id) ||
    id === '.' ||
    id === '..' ||
    id.includes('..') ||
    ['__proto__', 'prototype', 'constructor'].includes(id)
  ) {
    fail(`${path}.id가 안전하지 않습니다`)
  }
  const project = text(loop.project, `${path}.project`, 1, 128)
  if (
    !SAFE_PROJECT.test(project) ||
    project === '.' ||
    project === '..' ||
    project.includes('..') ||
    ['__proto__', 'prototype', 'constructor'].includes(project)
  ) {
    fail(`${path}.project는 안전한 프로젝트 별칭이어야 합니다`)
  }
  if (!Array.isArray(loop.checks) || loop.checks.length > 20) fail(`${path}.checks가 올바르지 않습니다`)
  const checks = loop.checks.map((check, checkIndex) => text(check, `${path}.checks[${checkIndex}]`, 1, 10_000))
  checks.forEach((check, checkIndex) => {
    if (!check.trim()) fail(`${path}.checks[${checkIndex}]는 비어 있을 수 없습니다`)
    assertNoSecret(check, `${path}.checks[${checkIndex}]`)
  })
  const mission = text(loop.mission, `${path}.mission`, 1, 100_000)
  if (!mission.trim()) fail(`${path}.mission은 비어 있을 수 없습니다`)
  assertNoSecret(mission, `${path}.mission`)
  const name = text(loop.name, `${path}.name`, 1, 120)
  if (!name.trim()) fail(`${path}.name은 비어 있을 수 없습니다`)
  assertNoSecret(name, `${path}.name`)
  const model = text(loop.model, `${path}.model`, 1, 200)
  assertNoSecret(model, `${path}.model`)
  if (/\s|[\0\r\n]/.test(model)) fail(`${path}.model이 올바르지 않습니다`)
  if (typeof loop.enabled !== 'boolean') fail(`${path}.enabled는 불리언이어야 합니다`)
  return {
    id,
    name,
    project,
    mission,
    trigger: validateTrigger(loop.trigger, `${path}.trigger`),
    model,
    checks,
    maxAttempts: integer(loop.maxAttempts, `${path}.maxAttempts`, 1, 20),
    timeoutMinutes: integer(loop.timeoutMinutes, `${path}.timeoutMinutes`, 1, 1440),
    enabled: loop.enabled
  }
}

function validateSkillPath(path: string): void {
  if (!path || path.length > 300 || path.includes('\\') || path.startsWith('/') || path.endsWith('/')) {
    fail(`omp.skills 경로가 안전하지 않습니다: ${path}`)
  }
  const parts = path.split('/')
  if (parts.length < 2 || parts.length > 12) fail(`omp.skills 경로가 올바르지 않습니다: ${path}`)
  for (const part of parts) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      part.startsWith('.') ||
      part.includes('\0') ||
      ['__proto__', 'prototype', 'constructor'].includes(part)
    ) {
      fail(`omp.skills 경로가 안전하지 않습니다: ${path}`)
    }
    if (SECRET_FILE.test(part)) fail(`비밀 파일은 동기화할 수 없습니다: ${path}`)
  }
}

function validateSkills(value: unknown): Record<string, string> {
  const entries = Object.entries(jsonObject(value, 'omp.skills'))
  if (entries.length > MAX_SKILL_FILES) fail('스킬 파일이 너무 많습니다')
  const result: Record<string, string> = {}
  let bytes = 0
  const roots = new Set<string>()
  const manifests = new Set<string>()
  for (const [path, contentValue] of entries) {
    validateSkillPath(path)
    const content = text(contentValue, `omp.skills[${JSON.stringify(path)}]`, 0, MAX_SKILL_FILE_BYTES)
    assertNoSecret(content, `omp.skills[${JSON.stringify(path)}]`)
    bytes += Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_SKILL_BYTES) fail('스킬 파일 합계가 너무 큽니다')
    const root = path.split('/')[0]
    roots.add(root)
    if (path === `${root}/SKILL.md`) manifests.add(root)
    result[path] = content
  }
  for (const root of roots) {
    if (!manifests.has(root)) fail(`${root}/SKILL.md가 없는 스킬 리소스가 있습니다`)
  }
  return result
}

export function validatePortableProfile(value: unknown): PortableProfile {
  assertFiniteJson(value, 'profile')
  const source = jsonObject(value, 'profile')
  assertExactKeys(source, ['version', 'omp', 'loops', 'workbench'], 'profile')
  if (source.version !== 1) fail('지원하지 않는 프로필 버전입니다')
  const ompSource = jsonObject(source.omp, 'omp')
  assertExactKeys(ompSource, ['config', 'instructions', 'skills'], 'omp')
  const instructions = text(ompSource.instructions, 'omp.instructions', 0, MAX_INSTRUCTIONS_BYTES)
  assertNoSecret(instructions, 'omp.instructions')
  if (!Array.isArray(source.loops) || source.loops.length > 256) fail('loops가 올바르지 않거나 너무 많습니다')
  const loops = source.loops.map(validateLoop)
  const ids = new Set<string>()
  for (const loop of loops) {
    if (ids.has(loop.id)) fail(`중복 루프 ID가 있습니다: ${loop.id}`)
    ids.add(loop.id)
  }
  const profile: PortableProfile = {
    version: 1,
    omp: {
      config: validateConfig(ompSource.config),
      instructions,
      skills: validateSkills(ompSource.skills)
    },
    loops
  }
  if (source.workbench !== undefined) profile.workbench = validateWorkbench(source.workbench)
  const encoded = JSON.stringify(profile)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PROFILE_BYTES) fail('프로필 파일이 너무 큽니다')
  return profile
}
function canonicalProfileHash(profile: PortableProfile): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const key of Object.keys(value).sort()) result[key] = canonicalize((value as Record<string, unknown>)[key])
      return result
    }
    return value
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(profile))).digest('hex')
}

function isPristineProfile(profile: PortableProfile): boolean {
  return (
    profile.loops.length === 0 &&
    profile.omp.instructions === '' &&
    Object.keys(profile.omp.config).length === 0 &&
    Object.keys(profile.omp.skills).length === 0
  )
}


function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function branchName(value: string): string {
  const branch = value.trim()
  if (
    !branch ||
    branch.length > 200 ||
    branch.startsWith('-') ||
    branch.startsWith('.') ||
    branch.endsWith('.') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    branch.includes('//') ||
    branch.endsWith('.lock') ||
    /[\x00-\x20~^:?*\[\\]/.test(branch)
  ) {
    fail('동기화 브랜치 이름이 안전하지 않습니다')
  }
  return branch
}

function remoteValue(value: string, root: string): string {
  const remote = value.trim()
  if (!remote || remote.length > 2048 || remote.startsWith('-') || /[\0\r\n]/.test(remote) || hasObviousSecret(remote)) {
    fail('동기화 원격 저장소 주소가 올바르지 않습니다')
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote)) {
    let url: URL
    try {
      url = new URL(remote)
    } catch {
      fail('동기화 원격 저장소 URL이 올바르지 않습니다')
    }
    if (!['https:', 'ssh:', 'file:'].includes(url.protocol)) fail('HTTPS, SSH 또는 로컬 원격 저장소만 지원합니다')
    if (url.password || (url.protocol === 'https:' && url.username) || url.search || url.hash) {
      fail('원격 저장소 URL에 자격 증명이나 쿼리를 넣을 수 없습니다')
    }
    if (url.protocol === 'file:') {
      if (url.username || url.password || url.host) fail('로컬 file URL이 올바르지 않습니다')
      return url.toString()
    }
    return remote
  }
  if (/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[^\s]+$/.test(remote)) return remote
  if (/^[A-Za-z]:[\\/]/.test(remote)) return resolve(remote)
  if (isAbsolute(remote)) return resolve(remote)
  if (remote.startsWith('~/')) fail('원격 저장소 로컬 경로에는 ~ 대신 절대 경로를 사용하세요')
  return resolve(root, remote)
}

function messageFrom(result: { stdout: string; stderr: string }, fallback: string): string {
  const line = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean)
  return line ? `${fallback}: ${line}` : fallback
}

interface RepoState {
  repo: string
  remote: string
  branch: string
}
interface SyncBaseline {
  remote: string
  branch: string
  profileHash: string
  commit: string
  lastSync: string
}

interface BaselineStore {
  version: 1
  entries: Record<string, SyncBaseline>
}

export class ProfileSync {
  private operation: Promise<void> = Promise.resolve()
  private lastSync?: string
  private lastMessage = SYNC_LIMITS

  constructor(private readonly options: SyncOptions) {}

  status(): Promise<SyncStatus> {
    return this.serial(async () => this.statusUnlocked())
  }

  push(): Promise<void> {
    return this.serial(async () => {
      try {
        const profile = validatePortableProfile(this.options.getProfile())
        const state = await this.ensureRepository()
        await this.pushUnlocked(state, profile)
        this.lastMessage = `휴대 가능한 OMP 설정과 루프를 안전하게 푸시했습니다. ${SYNC_LIMITS}`
      } catch (error) {
        this.lastMessage = statusError(error)
        throw error
      }
    })
  }

  pull(): Promise<void> {
    return this.serial(async () => {
      try {
        const state = await this.ensureRepository()
        await this.pullUnlocked(state)
        this.lastMessage = `휴대 가능한 OMP 설정과 루프를 안전하게 가져왔습니다. ${SYNC_LIMITS}`
      } catch (error) {
        this.lastMessage = statusError(error)
        throw error
      }
    })
  }

  importOmp(): Promise<PortableProfile['omp']> {
    return this.serial(async () => {
      try {
        const imported = await this.importOmpUnlocked()
        return imported
      } catch (error) {
        this.lastMessage = statusError(error)
        throw error
      }
    })
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private settings(): { remote: string; branch: string } {
    const settings = this.options.getSettings()
    return {
      remote: remoteValue(settings.syncRemote, this.options.root),
      branch: branchName(settings.syncBranch)
    }
  }
  private baselineId(state: RepoState): string {
    return createHash('sha256').update(`${state.remote}\0${state.branch}`).digest('hex')
  }

  private async loadBaselines(): Promise<BaselineStore> {
    const path = join(this.options.root, BASELINE_FILE)
    if (!existsSync(path)) return { version: 1, entries: {} }
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BASELINE_BYTES) {
      fail('로컬 동기화 기준 파일이 안전한 일반 파일이 아닙니다')
    }
    const buffer = await readFile(path)
    if (!isUtf8(buffer)) fail('로컬 동기화 기준 파일이 손상되었습니다')
    let parsed: unknown
    try {
      parsed = JSON.parse(buffer.toString('utf8'))
    } catch {
      fail('로컬 동기화 기준 파일이 손상되었습니다')
    }
    const source = jsonObject(parsed, 'sync-baselines')
    assertExactKeys(source, ['version', 'entries'], 'sync-baselines')
    if (source.version !== 1) fail('지원하지 않는 로컬 동기화 기준 버전입니다')
    const rows = jsonObject(source.entries, 'sync-baselines.entries')
    if (Object.keys(rows).length > 64) fail('로컬 동기화 기준 항목이 너무 많습니다')
    const entries: Record<string, SyncBaseline> = {}
    for (const [id, value] of Object.entries(rows)) {
      if (!/^[0-9a-f]{64}$/.test(id)) fail('로컬 동기화 기준 키가 올바르지 않습니다')
      const row = jsonObject(value, `sync-baselines.entries.${id}`)
      assertExactKeys(row, ['remote', 'branch', 'profileHash', 'commit', 'lastSync'], `sync-baselines.entries.${id}`)
      if (
        typeof row.remote !== 'string' ||
        row.remote.length === 0 ||
        row.remote.length > 2048 ||
        typeof row.branch !== 'string' ||
        branchName(row.branch) !== row.branch ||
        typeof row.profileHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(row.profileHash) ||
        typeof row.commit !== 'string' ||
        !/^[0-9a-f]{40,64}$/.test(row.commit) ||
        typeof row.lastSync !== 'string' ||
        !Number.isFinite(Date.parse(row.lastSync))
      ) {
        fail('로컬 동기화 기준 항목이 손상되었습니다')
      }
      entries[id] = {
        remote: row.remote,
        branch: row.branch,
        profileHash: row.profileHash,
        commit: row.commit,
        lastSync: row.lastSync
      }
    }
    return { version: 1, entries }
  }

  private async baselineFor(state: RepoState): Promise<SyncBaseline | undefined> {
    const baseline = (await this.loadBaselines()).entries[this.baselineId(state)]
    if (baseline && (baseline.remote !== state.remote || baseline.branch !== state.branch)) {
      fail('로컬 동기화 기준이 현재 원격 저장소와 일치하지 않습니다')
    }
    return baseline
  }

  private async saveBaseline(state: RepoState, profile: PortableProfile): Promise<void> {
    const store = await this.loadBaselines()
    const commitResult = await this.git(state, `rev-parse ${shellQuote(`refs/heads/${state.branch}`)}`)
    const commit = commitResult.stdout.trim()
    if (commitResult.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) fail('동기화된 Git 커밋을 확인하지 못했습니다')
    const lastSync = new Date().toISOString()
    store.entries[this.baselineId(state)] = {
      remote: state.remote,
      branch: state.branch,
      profileHash: canonicalProfileHash(profile),
      commit,
      lastSync
    }
    const body = `${JSON.stringify(store, null, 2)}\n`
    if (Buffer.byteLength(body, 'utf8') > MAX_BASELINE_BYTES) fail('로컬 동기화 기준 파일이 너무 큽니다')
    await mkdir(this.options.root, { recursive: true })
    const target = join(this.options.root, BASELINE_FILE)
    const temporary = join(this.options.root, `.${BASELINE_FILE}.${process.pid}.${Date.now()}.tmp`)
    try {
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, target)
      this.lastSync = lastSync
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async git(state: RepoState, command: string, timeoutMs = 60_000): Promise<{ code: number; stdout: string; stderr: string }> {
    return runCapture(`git ${command}`, state.repo, undefined, timeoutMs)
  }

  private async requireGit(state: RepoState, command: string, error: string, timeoutMs = 60_000): Promise<void> {
    const result = await this.git(state, command, timeoutMs)
    if (result.code !== 0) fail(messageFrom(result, error))
  }

  private async statusUnlocked(): Promise<SyncStatus> {
    const raw = this.options.getSettings()
    const base: SyncStatus = {
      connected: false,
      remote: raw.syncRemote,
      branch: raw.syncBranch,
      dirty: false,
      lastSync: this.lastSync,
      message: this.lastMessage
    }
    let remote: string
    let branch: string
    try {
      remote = remoteValue(raw.syncRemote, this.options.root)
      branch = branchName(raw.syncBranch)
    } catch (error) {
      return { ...base, message: statusError(error) }
    }
    const repo = join(this.options.root, 'sync-repo')
    const state = { repo, remote, branch }
    const baseline = await this.baselineFor(state)
    const currentProfile = validatePortableProfile(this.options.getProfile())
    const currentHash = canonicalProfileHash(currentProfile)
    const baselineDirty = baseline
      ? currentHash !== baseline.profileHash
      : !isPristineProfile(currentProfile)
    if (!existsSync(join(repo, '.git'))) {
      return {
        ...base,
        dirty: baselineDirty,
        lastSync: this.lastSync ?? baseline?.lastSync,
        message: `연결 전입니다. 원격 저장소는 자동 생성하지 않으며 첫 push/pull 때 기존 저장소에 연결합니다. ${SYNC_LIMITS}`
      }
    }
    const origin = await this.git(state, 'remote get-url origin')
    if (origin.code !== 0 || origin.stdout.trim() !== remote) {
      return {
        ...base,
        dirty: baselineDirty,
        lastSync: this.lastSync ?? baseline?.lastSync,
        message: `sync-repo의 origin이 현재 동기화 설정과 다릅니다. ${SYNC_LIMITS}`
      }
    }
    const applicationDirty = await this.hasUnsyncedApplicationProfile(state, currentProfile, baseline)
    let dirty = (await this.profileDirty(state)) || applicationDirty
    const localExists = await this.refExists(state, `refs/heads/${branch}`)
    const remoteExists = await this.refExists(state, `refs/remotes/origin/${branch}`)
    if (!dirty && localExists && remoteExists) {
      const relation = await this.relation(state)
      dirty = relation === 'ahead' || relation === 'diverged'
    }
    const current = await this.git(state, 'symbolic-ref --quiet --short HEAD')
    const logged = await this.git(state, `log -1 --format=%cI -- ${shellQuote(PROFILE_FILE)}`)
    let message = this.lastMessage
    if (applicationDirty) {
      message = `앱에서 저장했지만 아직 push하지 않은 프로필 변경이 있습니다. pull은 이 변경을 덮어쓰지 않습니다. ${SYNC_LIMITS}`
    } else if (current.code === 0 && current.stdout.trim() !== branch) {
      message = `현재 sync-repo 브랜치는 ${current.stdout.trim()}이며 설정된 브랜치는 ${branch}입니다. ${SYNC_LIMITS}`
    }
    return {
      connected: true,
      remote: raw.syncRemote,
      branch: raw.syncBranch,
      dirty,
      lastSync: this.lastSync ?? baseline?.lastSync ?? (logged.code === 0 ? logged.stdout.trim() || undefined : undefined),
      message
    }
  }

  private async ensureRepository(): Promise<RepoState> {
    const { remote, branch } = this.settings()
    const repo = join(this.options.root, 'sync-repo')
    await mkdir(this.options.root, { recursive: true })
    if (!existsSync(repo)) {
      const clone = await runCapture(
        `git clone --origin origin -- ${shellQuote(remote)} ${shellQuote(repo)}`,
        this.options.root,
        undefined,
        120_000
      )
      if (clone.code !== 0) fail(messageFrom(clone, '원격 저장소를 찾거나 복제할 수 없습니다. 저장소를 먼저 생성하세요'))
    } else if (!existsSync(join(repo, '.git'))) {
      const entries = await readdir(repo).catch(() => [])
      if (entries.length > 0) fail('sync-repo가 Git 저장소가 아니며 비어 있지도 않습니다')
      const clone = await runCapture(
        `git clone --origin origin -- ${shellQuote(remote)} ${shellQuote(repo)}`,
        this.options.root,
        undefined,
        120_000
      )
      if (clone.code !== 0) fail(messageFrom(clone, '원격 저장소를 찾거나 복제할 수 없습니다. 저장소를 먼저 생성하세요'))
    }
    const state = { repo, remote, branch }
    const inside = await this.git(state, 'rev-parse --is-inside-work-tree')
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') fail('sync-repo가 올바른 Git 작업 트리가 아닙니다')
    const origin = await this.git(state, 'remote get-url origin')
    if (origin.code !== 0) {
      await this.requireGit(state, `remote add origin ${shellQuote(remote)}`, 'origin을 설정할 수 없습니다')
    } else if (origin.stdout.trim() !== remote) {
      fail('기존 sync-repo의 origin이 현재 설정과 다릅니다. 자동으로 바꾸지 않습니다')
    }
    return state
  }

  private async remoteBranchExists(state: RepoState): Promise<boolean> {
    const result = await this.git(
      state,
      `ls-remote --exit-code --heads origin ${shellQuote(`refs/heads/${state.branch}`)}`,
      90_000
    )
    if (result.code === 0) return true
    if (result.code === 2) return false
    fail(messageFrom(result, '원격 저장소에 연결할 수 없습니다'))
  }

  private async fetchBranch(state: RepoState): Promise<void> {
    await this.requireGit(
      state,
      `fetch --no-tags origin ${shellQuote(`refs/heads/${state.branch}:refs/remotes/origin/${state.branch}`)}`,
      '원격 브랜치를 가져오지 못했습니다',
      120_000
    )
  }

  private async refExists(state: RepoState, ref: string): Promise<boolean> {
    const result = await this.git(state, `show-ref --verify --quiet ${shellQuote(ref)}`)
    return result.code === 0
  }

  private async switchToBranch(state: RepoState, remoteExists: boolean): Promise<void> {
    const localRef = `refs/heads/${state.branch}`
    const localExists = await this.refExists(state, localRef)
    const current = await this.git(state, 'symbolic-ref --quiet --short HEAD')
    if (localExists) {
      if (current.code === 0 && current.stdout.trim() === state.branch) return
      const changes = await this.git(state, 'status --porcelain --untracked-files=all')
      if (changes.stdout.trim()) fail('브랜치를 바꾸기 전에 sync-repo의 로컬 변경을 정리하세요')
      await this.requireGit(state, `switch ${shellQuote(state.branch)}`, '동기화 브랜치로 전환하지 못했습니다')
      return
    }
    if (!remoteExists && current.code === 0 && current.stdout.trim() === state.branch) return
    if (remoteExists) {
      await this.requireGit(
        state,
        `switch --create ${shellQuote(state.branch)} --track ${shellQuote(`origin/${state.branch}`)}`,
        '원격 동기화 브랜치를 체크아웃하지 못했습니다'
      )
      return
    }
    await this.requireGit(state, `switch --orphan ${shellQuote(state.branch)}`, '초기 동기화 브랜치를 만들지 못했습니다')
  }

  private async profileDirty(state: RepoState): Promise<boolean> {
    const result = await this.git(state, `status --porcelain --untracked-files=all -- ${shellQuote(PROFILE_FILE)}`)
    if (result.code !== 0) fail(messageFrom(result, '프로필 변경 상태를 확인하지 못했습니다'))
    return Boolean(result.stdout.trim())
  }

  private async relation(state: RepoState): Promise<'equal' | 'ahead' | 'behind' | 'diverged'> {
    const local = `refs/heads/${state.branch}`
    const remote = `refs/remotes/origin/${state.branch}`
    const equal = await this.git(state, `rev-parse ${shellQuote(local)} ${shellQuote(remote)}`)
    if (equal.code !== 0) fail('로컬 또는 원격 브랜치 참조가 없습니다')
    const [localSha, remoteSha] = equal.stdout.trim().split(/\s+/)
    if (localSha === remoteSha) return 'equal'
    const remoteAncestor = await this.git(state, `merge-base --is-ancestor ${shellQuote(remote)} ${shellQuote(local)}`)
    if (remoteAncestor.code === 0) return 'ahead'
    const localAncestor = await this.git(state, `merge-base --is-ancestor ${shellQuote(local)} ${shellQuote(remote)}`)
    if (localAncestor.code === 0) return 'behind'
    return 'diverged'
  }

  private async profileAtRef(
    state: RepoState,
    revision: string,
    required: boolean,
    label: string
  ): Promise<PortableProfile | undefined> {
    const ref = `${revision}:${PROFILE_FILE}`
    const sizeResult = await this.git(state, `cat-file -s ${shellQuote(ref)}`)
    if (sizeResult.code !== 0) {
      if (!required) return undefined
      fail(`${label}에 ${PROFILE_FILE}이 없습니다`)
    }
    const size = Number(sizeResult.stdout.trim())
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_PROFILE_BYTES) fail(`${label} 프로필 파일이 너무 큽니다`)
    const result = await this.git(state, `show ${shellQuote(ref)}`)
    if (result.code !== 0) fail(messageFrom(result, `${label} 프로필 파일을 읽지 못했습니다`))
    let value: unknown
    try {
      value = JSON.parse(result.stdout)
    } catch {
      fail(`${label} 프로필 JSON이 손상되었습니다`)
    }
    return validatePortableProfile(value)
  }

  private async remoteProfile(state: RepoState, required: boolean): Promise<PortableProfile | undefined> {
    return this.profileAtRef(state, `refs/remotes/origin/${state.branch}`, required, `원격 ${state.branch} 브랜치`)
  }
  private async hasUnsyncedApplicationProfile(
    state: RepoState,
    profile: PortableProfile,
    baseline: SyncBaseline | undefined
  ): Promise<boolean> {
    const currentHash = canonicalProfileHash(profile)
    if (baseline) return currentHash !== baseline.profileHash
    if (isPristineProfile(profile)) return false
    const localExists = await this.refExists(state, `refs/heads/${state.branch}`)
    if (!localExists) return true
    const localProfile = await this.profileAtRef(
      state,
      `refs/heads/${state.branch}`,
      false,
      `로컬 ${state.branch} 브랜치`
    )
    return !localProfile || canonicalProfileHash(localProfile) !== currentHash
  }

  private async assertOnlyProfileAhead(state: RepoState): Promise<void> {
    const result = await this.git(
      state,
      `log --format= --name-only ${shellQuote(`refs/remotes/origin/${state.branch}..refs/heads/${state.branch}`)} --`
    )
    if (result.code !== 0) fail(messageFrom(result, '게시되지 않은 커밋을 확인하지 못했습니다'))
    const paths = result.stdout.split(/\r?\n/).filter(Boolean)
    if (paths.some((path) => path !== PROFILE_FILE)) {
      fail('게시되지 않은 커밋에 palace-profile.json 외의 파일이 포함되어 있어 push를 거부했습니다')
    }
  }

  private async fastForward(state: RepoState): Promise<void> {
    await this.requireGit(
      state,
      `merge --ff-only ${shellQuote(`refs/remotes/origin/${state.branch}`)}`,
      '로컬 변경 때문에 원격 브랜치로 fast-forward할 수 없습니다'
    )
  }

  private async pushUnlocked(state: RepoState, profile: PortableProfile): Promise<void> {
    const baseline = await this.baselineFor(state)
    const hadLocalBranch = await this.refExists(state, `refs/heads/${state.branch}`)
    if (hadLocalBranch) {
      await this.switchToBranch(state, false)
      if (await this.profileDirty(state)) fail('게시되지 않은 palace-profile.json 작업 트리 변경이 있습니다')
    }
    const remoteExists = await this.remoteBranchExists(state)
    let remoteProfile: PortableProfile | undefined
    if (remoteExists) {
      await this.fetchBranch(state)
      // A credential-bearing or otherwise malicious remote profile is never silently replaced.
      remoteProfile = await this.remoteProfile(state, false)
    }
    await this.switchToBranch(state, remoteExists)
    if (await this.profileDirty(state)) fail('게시되지 않은 palace-profile.json 작업 트리 변경이 있습니다')

    if (remoteExists) {
      const relation = await this.relation(state)
      if (relation === 'diverged') fail('로컬과 원격 프로필 기록이 갈라졌습니다. 자동 병합이나 강제 push를 하지 않습니다')
      if (relation === 'behind') {
        fail('원격 프로필이 로컬보다 새롭습니다. push로 덮어쓰지 않습니다. 로컬 변경을 보존한 채 충돌을 먼저 해결하세요')
      }
      if (relation === 'ahead') await this.assertOnlyProfileAhead(state)
      if (!baseline && remoteProfile) {
        if (relation === 'equal' && canonicalProfileHash(profile) !== canonicalProfileHash(remoteProfile)) {
          fail('이 원격 저장소의 마지막 동기화 기준이 없고 로컬 앱 프로필이 원격과 다릅니다. 먼저 안전하게 내용을 확인하고 해결하세요')
        }
        if (relation === 'ahead') {
          const localProfile = await this.profileAtRef(
            state,
            `refs/heads/${state.branch}`,
            true,
            `로컬 ${state.branch} 브랜치`
          )
          if (!localProfile || canonicalProfileHash(localProfile) !== canonicalProfileHash(profile)) {
            fail('게시되지 않은 Git 프로필과 현재 앱 프로필이 달라 push를 거부했습니다')
          }
        }
      }
    } else if (hadLocalBranch) {
      const files = await this.git(state, `log --format= --name-only ${shellQuote(`refs/heads/${state.branch}`)} --`)
      if (files.code !== 0) fail(messageFrom(files, '새 브랜치의 로컬 커밋을 확인하지 못했습니다'))
      if (files.stdout.split(/\r?\n/).filter(Boolean).some((path) => path !== PROFILE_FILE)) {
        fail('새 원격 브랜치에 palace-profile.json 외의 기존 로컬 기록을 게시하지 않습니다')
      }
    }

    await this.writeProfile(state.repo, profile)
    await this.requireGit(state, `add -- ${shellQuote(PROFILE_FILE)}`, '프로필을 Git 인덱스에 추가하지 못했습니다')
    const staged = await this.git(state, `diff --cached --quiet -- ${shellQuote(PROFILE_FILE)}`)
    if (staged.code === 1) {
      await this.requireGit(
        state,
        `-c user.name=${shellQuote('Palace OMP')} -c user.email=${shellQuote('palace-omp@localhost')} commit --only -m ${shellQuote(
          'Sync Palace OMP profile'
        )} -- ${shellQuote(PROFILE_FILE)}`,
        '프로필 커밋을 만들지 못했습니다'
      )
    } else if (staged.code !== 0) {
      fail(messageFrom(staged, '프로필 커밋 변경을 확인하지 못했습니다'))
    }
    await this.requireGit(
      state,
      `push origin ${shellQuote(`HEAD:refs/heads/${state.branch}`)}`,
      'fast-forward push에 실패했습니다. 원격 변경과 로컬 앱 변경을 보존한 채 충돌을 해결하세요',
      120_000
    )
    await this.saveBaseline(state, profile)
  }

  private async pullUnlocked(state: RepoState): Promise<void> {
    const currentProfile = validatePortableProfile(this.options.getProfile())
    const baseline = await this.baselineFor(state)
    if (await this.hasUnsyncedApplicationProfile(state, currentProfile, baseline)) {
      fail('앱에서 저장했지만 아직 push하지 않은 프로필 변경이 있어 pull을 거부했습니다. 로컬 변경을 먼저 보존하거나 해결하세요')
    }
    const hadLocalBranch = await this.refExists(state, `refs/heads/${state.branch}`)
    if (hadLocalBranch) {
      await this.switchToBranch(state, false)
      if (await this.profileDirty(state)) fail('게시되지 않은 palace-profile.json 작업 트리 변경이 있어 pull을 중단했습니다')
    }
    const remoteExists = await this.remoteBranchExists(state)
    if (!remoteExists) fail(`원격 저장소에 ${state.branch} 브랜치가 없습니다. 다른 컴퓨터에서 먼저 push하세요`)
    await this.fetchBranch(state)
    const profile = await this.remoteProfile(state, true)
    if (!profile) fail('원격 프로필을 읽지 못했습니다')
    await this.switchToBranch(state, true)
    if (await this.profileDirty(state)) fail('게시되지 않은 palace-profile.json 작업 트리 변경이 있어 pull을 중단했습니다')
    const relation = await this.relation(state)
    if (relation === 'diverged') fail('로컬과 원격 프로필 기록이 갈라졌습니다. 자동 병합이나 reset을 하지 않습니다')
    if (relation === 'ahead') fail('게시되지 않은 로컬 프로필 커밋이 있습니다. pull로 덮어쓰지 않습니다')
    if (relation === 'behind') await this.fastForward(state)
    // The callback is invoked only after the complete remote blob has passed every validator.
    this.options.setProfile(profile)
    try {
      await this.saveBaseline(state, profile)
    } catch (error) {
      this.options.setProfile(currentProfile)
      throw error
    }
  }

  private async writeProfile(repo: string, profile: PortableProfile): Promise<void> {
    const body = `${JSON.stringify(profile, null, 2)}\n`
    const target = join(repo, PROFILE_FILE)
    const temporary = join(repo, `.${PROFILE_FILE}.${process.pid}.${Date.now()}.tmp`)
    try {
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, target)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async importOmpUnlocked(): Promise<PortableProfile['omp']> {
    const configuredRoot = process.env.PI_CODING_AGENT_DIR
    const requestedRoot = configuredRoot ? resolve(configuredRoot) : join(homedir(), '.omp', 'agent')
    let root: string
    try {
      root = await realpath(requestedRoot)
    } catch {
      fail(`OMP 설정 디렉터리를 찾을 수 없습니다: ${requestedRoot}`)
    }
    const rawConfig = await this.readYamlConfig(root)
    const { config, skipped } = this.curateConfig(rawConfig)
    const instructions = await this.readInstructions(root)
    const skills = await this.readSkills(root)
    const omp = validatePortableProfile({ version: 1, omp: { config, instructions, skills }, loops: [] }).omp
    this.lastMessage = skipped.length
      ? `OMP 가져오기 완료. 휴대할 수 없는 설정은 제외했습니다: ${skipped.join(', ')}`
      : 'OMP 가져오기 완료. 인증, 머신 경로, 승인 정책, 실행 확장은 원래부터 포함하지 않습니다.'
    return omp
  }

  private async readYamlConfig(root: string): Promise<Record<string, unknown>> {
    let path = join(root, 'config.yml')
    if (!existsSync(path) && existsSync(join(root, 'config.yaml'))) path = join(root, 'config.yaml')
    if (!existsSync(path)) return {}
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) fail('OMP config.yml이 안전한 일반 파일이 아닙니다')
    const buffer = await readFile(path)
    if (!isUtf8(buffer)) fail('OMP config.yml은 UTF-8 텍스트 파일이어야 합니다')
    const source = buffer.toString('utf8')
    let value: unknown
    try {
      value = parse(source)
    } catch (error) {
      fail(`OMP config.yml을 파싱할 수 없습니다: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (value === null || value === undefined) return {}
    assertFiniteJson(value, 'config.yml')
    return jsonObject(value, 'config.yml')
  }

  private curateConfig(raw: Record<string, unknown>): { config: Record<string, unknown>; skipped: string[] } {
    const config: Record<string, unknown> = {}
    const skipped: string[] = []
    for (const [key, value] of Object.entries(raw)) {
      if (!Object.hasOwn(PORTABLE_CONFIG_KEYS, key)) {
        skipped.push(key)
        continue
      }
      if (key === 'providers') {
        let providerSource: Record<string, unknown>
        try {
          providerSource = jsonObject(value, 'config.yml.providers')
        } catch {
          skipped.push(key)
          continue
        }
        const providers: Record<string, unknown> = {}
        for (const [providerKey, providerValue] of Object.entries(providerSource)) {
          if (!Object.hasOwn(PORTABLE_PROVIDER_KEYS, providerKey)) {
            skipped.push(`providers.${providerKey}`)
            continue
          }
          try {
            assertPortableConfigNode(providerValue, `config.yml.providers.${providerKey}`, providerKey)
            providers[providerKey] = providerValue
          } catch {
            skipped.push(`providers.${providerKey}`)
          }
        }
        if (Object.keys(providers).length) config.providers = providers
        continue
      }
      try {
        assertPortableConfigNode(value, `config.yml.${key}`, key)
        config[key] = value
      } catch {
        skipped.push(key)
      }
    }
    return { config: validateConfig(config), skipped }
  }

  private async readInstructions(root: string): Promise<string> {
    for (const name of ['AGENTS.md', 'INSTRUCTIONS.md', 'instructions.md']) {
      const path = join(root, name)
      if (!existsSync(path)) continue
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_INSTRUCTIONS_BYTES) {
        fail(`${name}이 안전한 일반 파일이 아닙니다`)
      }
      const buffer = await readFile(path)
      if (!isUtf8(buffer)) fail(`${name}은 UTF-8 텍스트 파일이어야 합니다`)
      const content = buffer.toString('utf8')
      assertNoSecret(content, name)
      return content
    }
    return ''
  }

  private async readSkills(root: string): Promise<Record<string, string>> {
    const skillsRoot = join(root, 'skills')
    if (!existsSync(skillsRoot)) return {}
    const rootInfo = await lstat(skillsRoot)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('OMP skills 디렉터리가 안전하지 않습니다')
    const resolvedRoot = await realpath(skillsRoot)
    const result: Record<string, string> = {}
    let bytes = 0
    let files = 0

    const walk = async (directory: string, parts: string[]): Promise<void> => {
      if (parts.length > 11) fail('스킬 디렉터리 중첩이 너무 깊습니다')
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((left, right) => left.name.localeCompare(right.name))
      for (const entry of entries) {
        if (entry.name.startsWith('.') || SECRET_FILE.test(entry.name)) continue
        const childParts = [...parts, entry.name]
        const relativePath = childParts.join('/')
        const path = join(directory, entry.name)
        const info = await lstat(path)
        if (info.isSymbolicLink()) continue
        const resolvedPath = await realpath(path)
        const escaped = relative(resolvedRoot, resolvedPath)
        if (escaped.startsWith(`..${sep}`) || escaped === '..' || isAbsolute(escaped)) continue
        if (info.isDirectory()) {
          await walk(path, childParts)
          continue
        }
        if (!info.isFile() || childParts.length < 2) continue
        if (info.size > MAX_SKILL_FILE_BYTES) {
          if (entry.name === 'SKILL.md') fail(`${relativePath}가 너무 큽니다`)
          continue
        }
        validateSkillPath(relativePath)
        const buffer = await readFile(path)
        if (!isUtf8(buffer) || buffer.includes(0)) continue
        if (files >= MAX_SKILL_FILES) fail('스킬 텍스트 파일이 너무 많습니다')
        const content = buffer.toString('utf8')
        assertNoSecret(content, `skills/${relativePath}`)
        bytes += buffer.byteLength
        if (bytes > MAX_SKILL_BYTES) fail('스킬 파일 합계가 너무 큽니다')
        files += 1
        result[relativePath] = content
      }
    }

    await walk(skillsRoot, [])
    // Ignore resource-only directories rather than producing an invalid portable profile.
    const manifests = new Set(
      Object.keys(result)
        .filter((path) => path.split('/').length === 2 && basename(path) === 'SKILL.md')
        .map((path) => path.split('/')[0])
    )
    for (const path of Object.keys(result)) {
      if (!manifests.has(path.split('/')[0])) delete result[path]
    }
    return result
  }
}
