import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentProfile } from '../../shared/workbench'
import type { PortableProfile } from '../../shared/automation'

export interface SessionRuntimeFiles {
  directory: string
  configPath: string
  instructionsPath?: string
  sessionsDirectory: string
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function safeSkillPath(root: string, path: string): string {
  if (!path || path.includes('\\') || path.startsWith('/') || path.endsWith('/')) throw new Error(`OMP 스킬 경로가 올바르지 않습니다: ${path}`)
  const parts = path.split('/')
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error(`OMP 스킬 경로가 안전하지 않습니다: ${path}`)
  }
  const target = resolve(root, ...parts)
  const scoped = relative(root, target)
  if (!scoped || scoped === '..' || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) throw new Error(`OMP 스킬 경로가 실행 디렉터리를 벗어납니다: ${path}`)
  return target
}

export async function materializeSessionRuntime(input: {
  runtimeRoot: string
  sessionId: string
  workspaceCwd: string
  projectSkills?: string
  omp: PortableProfile['omp']
  profile?: AgentProfile
}): Promise<SessionRuntimeFiles> {
  const directory = join(input.runtimeRoot, input.sessionId)
  const skillsDirectory = join(directory, 'skills')
  const sessionsDirectory = join(directory, 'sessions')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await rm(skillsDirectory, { recursive: true, force: true })
  await mkdir(skillsDirectory, { recursive: true, mode: 0o700 })
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 })

  const topLevels = new Set<string>()
  for (const [path, content] of Object.entries(input.omp.skills)) {
    if (typeof content !== 'string' || content.includes('\0')) throw new Error(`OMP 스킬 파일 내용이 올바르지 않습니다: ${path}`)
    const target = safeSkillPath(skillsDirectory, path)
    topLevels.add(path.split('/')[0])
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 })
    await writeFile(target, content, { encoding: 'utf8', mode: 0o600 })
  }
  for (const skill of topLevels) {
    if (!Object.prototype.hasOwnProperty.call(input.omp.skills, `${skill}/SKILL.md`)) throw new Error(`OMP 스킬 ${skill}에 SKILL.md가 없습니다`)
  }

  const config = cloneJsonRecord(input.omp.config)
  const skillsConfig = { ...(objectRecord(config.skills) ?? {}) }
  const configuredDirectories = Array.isArray(skillsConfig.customDirectories)
    ? skillsConfig.customDirectories.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : []
  const directories = [...configuredDirectories]
  if (Object.keys(input.omp.skills).length > 0) directories.push(skillsDirectory)
  const projectSkills = join(input.workspaceCwd, '.agent', 'skills')
  directories.push(projectSkills)
  if (input.projectSkills) directories.push(input.projectSkills)
  if (directories.length > 0) skillsConfig.customDirectories = [...new Set(directories)]
  config.skills = skillsConfig

  const configPath = join(directory, 'config.json')
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  const instructions = [input.omp.instructions.trim(), input.profile?.instructions.trim() ?? ''].filter(Boolean).join('\n\n')
  let instructionsPath: string | undefined
  if (instructions) {
    instructionsPath = join(directory, 'INSTRUCTIONS.md')
    await writeFile(instructionsPath, `${instructions}\n`, { encoding: 'utf8', mode: 0o600 })
  } else {
    await rm(join(directory, 'INSTRUCTIONS.md'), { force: true })
  }
  return { directory, configPath, instructionsPath, sessionsDirectory }
}
