import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import type { SkillCandidate } from '../../shared/workbench'

const TREE_LIMIT = 32 * 1024 * 1024
const FILE_LIMIT = 2 * 1024 * 1024
const SKILL_LIMIT = 8 * 1024 * 1024
const SKILL_FILES_LIMIT = 250

export interface RepositoryFile {
  path: string
  oid: string
  mode: string
  size: number
  bytes?: Buffer
}

export interface RepositorySkill extends SkillCandidate {
  directory: string
  manifestPath: string
}

export interface RepositorySnapshot {
  source: string
  revision: string
  repository: string
  skills: RepositorySkill[]
  entries: Map<string, { mode: string; type: string; oid: string }>
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false'
  }
  delete environment.GIT_CONFIG_PARAMETERS
  delete environment.GIT_CONFIG_SYSTEM
  return environment
}

async function git(args: string[], cwd?: string, limit = TREE_LIMIT): Promise<Buffer> {
  const child = spawn('git', args, { cwd, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let bytes = 0
  let stderrBytes = 0
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > limit) child.kill('SIGKILL')
    else stdout.push(chunk)
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length
    if (stderrBytes <= 64 * 1024) stderr.push(chunk)
  })
  let code: number | null
  let signal: NodeJS.Signals | null
  try {
    [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  } finally {
    clearTimeout(timer)
  }
  if (bytes > limit) throw new Error('저장소 응답이 안전한 크기 제한을 넘었습니다.')
  if (code !== 0) {
    const detail = Buffer.concat(stderr).toString('utf8').trim().split('\n').slice(-2).join(' ')
    throw new Error(`Git 저장소를 읽지 못했습니다${detail ? `: ${detail}` : signal ? ` (${signal})` : ''}`)
  }
  return Buffer.concat(stdout)
}


async function localSource(value: string): Promise<string> {
  const absolute = resolve(value)
  const info = await stat(absolute).catch(() => null)
  if (!info?.isDirectory()) throw new Error('로컬 스킬 소스는 존재하는 Git 저장소 디렉터리여야 합니다.')
  return realpath(absolute)
}

export async function normalizeSkillSource(input: string): Promise<string> {
  const value = input.trim()
  if (!value || value.length > 2048 || value.includes('\0') || /[\r\n]/.test(value)) throw new Error('올바른 스킬 저장소를 입력하세요.')
  if (isAbsolute(value) || value.startsWith('./') || value.startsWith('../') || value === '.') return localSource(value)

  const shorthand = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}.git`

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('GitHub 주소(owner/repo 또는 https://github.com/owner/repo)를 입력하세요.')
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('자격 증명이 없는 HTTPS GitHub 저장소만 지원합니다.')
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/)
  if (!match) throw new Error('GitHub 저장소 루트 주소를 입력하세요.')
  return `https://github.com/${match[1]}/${match[2]}.git`
}

function safeRepositoryPath(path: string): boolean {
  if (!path || path.includes('\0') || path.startsWith('/') || path.includes('\\')) return false
  const clean = normalize(path).replaceAll('\\', '/')
  return clean === path && clean !== '..' && !clean.startsWith('../') && !clean.includes('/../')
}

function safeId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '')
  if (!id || id.length > 80 || id === '.' || id === '..') throw new Error(`안전하지 않은 스킬 이름입니다: ${value}`)
  return id
}

function metadata(text: string, fallback: string): { id: string; name: string; description: string } {
  let name = fallback
  let description = ''
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/)
  if (frontmatter) {
    const document = parseDocument(frontmatter[1])
    if (document.errors.length) throw new Error(`SKILL.md 메타데이터가 올바른 YAML이 아닙니다: ${document.errors[0].message}`)
    const value = document.toJS({ maxAliasCount: 10 }) as unknown
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      if (typeof record.name === 'string' && record.name.trim()) name = record.name.trim()
      if (typeof record.description === 'string') description = record.description.trim()
    }
  }
  return { id: safeId(name), name, description }
}

function parseTree(raw: Buffer): Map<string, { mode: string; type: string; oid: string }> {
  const entries = new Map<string, { mode: string; type: string; oid: string }>()
  for (const item of raw.toString('utf8').split('\0')) {
    if (!item) continue
    const match = item.match(/^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/)
    if (!match || !safeRepositoryPath(match[4])) throw new Error('저장소에 안전하지 않은 경로가 있습니다.')
    if (entries.size >= 50_000) throw new Error('저장소 파일 수가 안전한 제한을 넘었습니다.')
    entries.set(match[4], { mode: match[1], type: match[2], oid: match[3] })
  }
  return entries
}

export class SkillRepositoryCache {
  private readonly cacheRoot: string
  private readonly active = new Map<string, Promise<RepositorySnapshot>>()

  constructor(root: string) {
    this.cacheRoot = join(root, 'workbench', 'skill-cache')
  }

  async snapshot(input: string, revision?: string): Promise<RepositorySnapshot> {
    const source = await normalizeSkillSource(input)
    const key = `${source}\0${revision ?? 'HEAD'}`
    const existing = this.active.get(key)
    if (existing) return existing
    const operation = this.load(source, revision).finally(() => this.active.delete(key))
    this.active.set(key, operation)
    return operation
  }

  private async load(source: string, requested?: string): Promise<RepositorySnapshot> {
    if (requested && !/^[0-9a-f]{40,64}$/i.test(requested)) throw new Error('리비전은 전체 Git 커밋 해시여야 합니다.')
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 })
    const repository = join(this.cacheRoot, createHash('sha256').update(source).digest('hex'))
    const head = join(repository, 'HEAD')
    try {
      await readFile(head)
    } catch {
      await mkdir(dirname(repository), { recursive: true, mode: 0o700 })
      await git(['init', '--bare', repository])
    }

    const ref = requested ?? 'HEAD'
    await git(['fetch', '--force', '--depth=1', '--no-tags', source, ref], repository)
    const revision = (await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], repository, 1024)).toString('utf8').trim()
    if (requested && revision.toLowerCase() !== requested.toLowerCase()) throw new Error('요청한 고정 리비전을 가져오지 못했습니다.')
    const entries = parseTree(await git(['ls-tree', '-r', '-z', '--full-tree', revision], repository))
    const skills: RepositorySkill[] = []
    const ids = new Set<string>()
    for (const [path, entry] of entries) {
      if (entry.type !== 'blob' || basename(path) !== 'SKILL.md') continue
      const bytes = await git(['cat-file', 'blob', entry.oid], repository, FILE_LIMIT + 1)
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const directory = dirname(path) === '.' ? '' : dirname(path)
      const fallback = directory ? basename(directory) : basename(source.replace(/\.git$/, ''))
      const parsed = metadata(text, fallback)
      if (ids.has(parsed.id)) throw new Error(`저장소에 같은 스킬 ID가 둘 이상 있습니다: ${parsed.id}`)
      ids.add(parsed.id)
      skills.push({ ...parsed, source, path: directory || '.', directory, manifestPath: path })
    }
    skills.sort((left, right) => left.name.localeCompare(right.name))
    return { source, revision, repository, skills, entries }
  }

  async files(snapshot: RepositorySnapshot, skill: RepositorySkill, includeBytes = true): Promise<RepositoryFile[]> {
    const prefix = skill.directory ? `${skill.directory}/` : ''
    const selected = [...snapshot.entries.entries()].filter(([path]) => !prefix || path.startsWith(prefix))
    if (selected.length > SKILL_FILES_LIMIT) throw new Error(`스킬 파일이 ${SKILL_FILES_LIMIT}개를 넘어 설치할 수 없습니다.`)
    const files: RepositoryFile[] = []
    let total = 0
    for (const [path, entry] of selected) {
      if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
        throw new Error(`지원하지 않는 스킬 자산입니다(심볼릭 링크/서브모듈/특수 파일): ${path}`)
      }
      const relative = prefix ? path.slice(prefix.length) : path
      if (!safeRepositoryPath(relative)) throw new Error(`안전하지 않은 스킬 파일 경로입니다: ${path}`)
      const bytes = await git(['cat-file', 'blob', entry.oid], snapshot.repository, FILE_LIMIT + 1)
      if (bytes.length > FILE_LIMIT) throw new Error(`스킬 자산이 파일당 2 MiB 제한을 넘습니다: ${relative}`)
      total += bytes.length
      if (total > SKILL_LIMIT) throw new Error('스킬 전체 크기가 8 MiB 제한을 넘습니다.')
      files.push({ path: relative, oid: entry.oid, mode: entry.mode, size: bytes.length, bytes: includeBytes ? bytes : undefined })
    }
    if (!files.some((file) => file.path === 'SKILL.md')) throw new Error('선택한 스킬에 SKILL.md가 없습니다.')
    return files
  }
}
