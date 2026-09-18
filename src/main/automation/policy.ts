import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import type { PortableProfile } from '../../shared/automation'

const FORBIDDEN_TOOL_POLICIES: Record<string, 'deny'> = {
  apply_patch: 'deny',
  ast_edit: 'deny',
  browser: 'deny',
  checkpoint: 'deny',
  computer: 'deny',
  debug: 'deny',
  generate_image: 'deny',
  github: 'deny',
  hub: 'deny',
  launch: 'deny',
  learn: 'deny',
  manage_skill: 'deny',
  memory_edit: 'deny',
  notebook: 'deny',
  recall: 'deny',
  reflect: 'deny',
  resolve: 'deny',
  retain: 'deny',
  rewind: 'deny',
  task: 'deny',
  tts: 'deny'
}

const ALLOWED_TOOL_POLICIES: Record<string, 'allow'> = {
  bash: 'allow',
  edit: 'allow',
  eval: 'allow',
  glob: 'allow',
  grep: 'allow',
  lsp: 'allow',
  read: 'allow',
  todo: 'allow',
  write: 'allow'
}

export interface MaterializedPolicy {
  overlayPath: string
  instructionsPath: string
  extensionPath: string
  skillsRoot: string
}
function assertSafeConfigKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeConfigKeys(entry)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`허용되지 않는 OMP 설정 키입니다: ${key}`)
    }
    assertSafeConfigKeys(entry)
  }
}



function mergeRecords(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`허용되지 않는 OMP 설정 키입니다: ${key}`)
    }
    const current = result[key]
    const currentObject =
      current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : undefined
    const overlayObject =
      value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
    result[key] = currentObject && overlayObject ? mergeRecords(currentObject, overlayObject) : value
  }
  return result
}

function validateSkillPath(path: string): string {
  if (!path || path.includes('\\') || posix.isAbsolute(path)) throw new Error(`안전하지 않은 스킬 경로입니다: ${path}`)
  const segments = path.split('/')
  const secretPattern = /(^|[._-])(env|secret|credential|token|password|private[-_]?key)([._-]|$)/i
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.startsWith('.') ||
        segment === '.git' ||
        secretPattern.test(segment)
    )
  ) {
    throw new Error(`안전하지 않은 스킬 경로입니다: ${path}`)
  }
  const normalized = posix.normalize(path)
  if (normalized !== path) throw new Error(`정규화되지 않은 스킬 경로입니다: ${path}`)
  return normalized
}

function guardExtensionSource(readonlyRoots: string[]): string {
  return `import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const readonlyRoots = ${JSON.stringify(readonlyRoots)}
const safeTools = { bash: true, edit: true, eval: true, glob: true, grep: true, lsp: true, read: true, todo: true, write: true }
const mutatingTools = { edit: true, write: true }
const pathTools = { edit: true, write: true, read: true, grep: true, glob: true, lsp: true }
const forbiddenShell = [
  /\\bgit\\s+(?:-[^\\s]+\\s+)*(?:push|merge|pull|rebase|cherry-pick|am|send-email)\\b/i,
  /\\bgh\\s+(?:pr\\s+(?:create|merge)|release\\s+create|repo\\s+(?:create|delete))\\b/i,
  /\\b(?:npm|pnpm|yarn|cargo)\\s+publish\\b/i,
  /\\bdocker\\s+(?:push|login)\\b/i,
  /\\bkubectl\\s+(?:apply|create|delete|replace|patch|set|rollout|scale)\\b/i,
  /\\b(?:terraform|tofu)\\s+(?:apply|destroy|import)\\b/i,
  /\\b(?:vercel|netlify|flyctl|railway|wrangler)\\b[^\\n;&|]*\\b(?:deploy|publish|destroy|delete)\\b/i,
  /\\bcurl\\b[^\\n;&|]*(?:-X|--request)\\s*(?:POST|PUT|PATCH|DELETE)\\b/i,
  /\\bwget\\b[^\\n;&|]*(?:--post-data|--post-file|--method\\s*=?(?:POST|PUT|PATCH|DELETE))\\b/i
]

function localPath(value, cwd) {
  if (typeof value !== 'string' || !value || /^[a-z][a-z0-9+.-]*:\\/\\//i.test(value)) return undefined
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value)
}

function inside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

async function canonicalPath(candidate) {
  const suffix = []
  let cursor = candidate
  while (true) {
    try {
      return resolve(await realpath(cursor), ...suffix)
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      suffix.unshift(basename(cursor))
      cursor = parent
    }
  }
}

export default function palaceAutomationGuard(pi) {
  pi.on('tool_call', async (event, ctx) => {
    const name = String(event.toolName || '')
    if (!safeTools[name]) {
      return { block: true, reason: 'Palace OMP automation exposes only scoped workspace and read-only discovery tools.' }
    }
    const input = event.input && typeof event.input === 'object' ? event.input : {}
    if (name === 'bash' || name === 'eval') {
      const executable = name === 'bash'
        ? String(input.command || '')
        : [input.code, input.expression].filter((value) => typeof value === 'string').join('\\n')
      if (forbiddenShell.some((pattern) => pattern.test(executable))) {
        return { block: true, reason: 'Palace OMP automation forbids push, merge, deploy, publish, and remote mutation commands.' }
      }
    }
    if (pathTools[name]) {
      const values = [input.path, input.file, input.cwd, input.dst, input.destination]
      for (const value of values) {
        const candidate = localPath(value, ctx.cwd)
        if (candidate && !inside(await canonicalPath(resolve(ctx.cwd)), await canonicalPath(candidate))) {
          if (['read', 'grep', 'glob'].includes(name) && (await Promise.all(readonlyRoots.map(async (root) => inside(await canonicalPath(root), await canonicalPath(candidate))))).some(Boolean)) continue
          return { block: true, reason: mutatingTools[name]
            ? 'Palace approval permits edits only inside the isolated worktree.'
            : 'Palace automation blocks local filesystem access outside the isolated worktree.' }
        }
      }
      if (name === 'edit' && typeof input.patch === 'string') {
        for (const match of input.patch.matchAll(/^\\[([^#\\]\\r\\n]+)#[0-9A-F]{4}\\]$/gm)) {
          const candidate = localPath(match[1], ctx.cwd)
          if (candidate && !inside(await canonicalPath(resolve(ctx.cwd)), await canonicalPath(candidate))) {
            return { block: true, reason: 'Palace approval permits edits only inside the isolated worktree.' }
          }
        }
      }
    }
  })
}
`
}

export async function materializePolicy(
  runDir: string,
  profile: PortableProfile['omp'],
  timeoutSeconds: number,
  projectSkills?: string
): Promise<MaterializedPolicy> {
  const skillsRoot = join(runDir, 'skills')
  const extensionPath = join(runDir, 'guard.js')
  assertSafeConfigKeys(profile.config)
  const instructionsPath = join(runDir, 'INSTRUCTIONS.md')
  const overlayPath = join(runDir, 'config.yml')
  await mkdir(skillsRoot, { recursive: true, mode: 0o700 })
  const skillDirectories = [skillsRoot]
  if (projectSkills) {
    try {
      const stat = await lstat(projectSkills)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('프로젝트 .agent/skills는 실제 디렉터리여야 합니다')
      skillDirectories.push(projectSkills)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  const topLevels = new Set<string>()
  for (const [rawPath, content] of Object.entries(profile.skills)) {
    const relativePath = validateSkillPath(rawPath)
    if (typeof content !== 'string' || content.includes('\0')) throw new Error(`스킬 파일 내용이 올바르지 않습니다: ${rawPath}`)
    topLevels.add(relativePath.split('/')[0])
    const target = resolve(skillsRoot, ...relativePath.split('/'))
    const relativeTarget = relative(resolve(skillsRoot), target)
    if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
      throw new Error(`스킬 경로가 실행 디렉터리를 벗어납니다: ${rawPath}`)
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  }
  for (const name of topLevels) {
    if (!Object.prototype.hasOwnProperty.call(profile.skills, `${name}/SKILL.md`)) {
      throw new Error(`스킬 ${name}에 SKILL.md가 없습니다`)
    }
  }

  const configuredDisabledExtensions = Array.isArray(profile.config.disabledExtensions)
    ? profile.config.disabledExtensions.filter(
        (entry): entry is string => typeof entry === 'string' && entry !== 'extension-module:guard'
      )
    : []
  const safetyOverlay: Record<string, unknown> = {
    async: { enabled: false },
    bash: { autoBackground: { enabled: false } },
    browser: { enabled: false },
    computer: { enabled: false },
    launch: { enabled: false },
    retry: { maxRetries: 2 },
    disabledExtensions: configuredDisabledExtensions,
    skills: { customDirectories: skillDirectories },
    task: { isolation: { enabled: false } },
    tools: {
      approvalMode: 'yolo',
      approval: { ...ALLOWED_TOOL_POLICIES, ...FORBIDDEN_TOOL_POLICIES },
      maxTimeout: Math.max(1, Math.min(300, Math.floor(timeoutSeconds)))
    }
  }
  const overlay = mergeRecords(profile.config, safetyOverlay)
  await writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await writeFile(instructionsPath, profile.instructions, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await writeFile(extensionPath, guardExtensionSource(skillDirectories), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return { overlayPath, instructionsPath, extensionPath, skillsRoot }
}
