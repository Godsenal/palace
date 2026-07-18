import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runCapture, runStreaming } from './exec'
import type { GitInfo } from '../shared/types'

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

/** 로컬 git 상태(fetch 안 함 → 빠름). behind/ahead 는 마지막 fetch 기준. */
export async function gitInfo(dir: string, shell?: string): Promise<GitInfo> {
  if (!isGitRepo(dir)) return {}
  const [branch, sha, status, counts] = await Promise.all([
    runCapture('git rev-parse --abbrev-ref HEAD', dir, shell),
    runCapture('git rev-parse --short HEAD', dir, shell),
    runCapture('git status --porcelain', dir, shell),
    runCapture('git rev-list --left-right --count @{u}...HEAD 2>/dev/null', dir, shell)
  ])
  const info: GitInfo = {
    branch: branch.stdout.trim() || undefined,
    shortSha: sha.stdout.trim() || undefined,
    dirty: status.stdout.trim().length > 0
  }
  const m = counts.stdout.trim().match(/^(\d+)\s+(\d+)$/)
  if (m) {
    info.behind = Number(m[1])
    info.ahead = Number(m[2])
    info.updateAvailable = info.behind > 0
  }
  return info
}

/** origin fetch 후 최신 behind 수 반영. */
export async function fetchAndCompare(dir: string, shell?: string): Promise<GitInfo> {
  if (!isGitRepo(dir)) return {}
  await runCapture('git fetch --quiet', dir, shell, 90_000)
  return gitInfo(dir, shell)
}

/** repo 를 targetDir 로 clone. 진행 스트리밍. */
export async function clone(
  repo: string,
  targetDir: string,
  onLine: (line: string, level: 'info' | 'error') => void,
  shell?: string
): Promise<number> {
  // ssh 실패 시 https 폴백은 호출측에서 결정. 여기선 주어진 repo 로만.
  const cmd = `git clone --progress ${quote(repo)} ${quote(targetDir)}`
  return runStreaming(cmd, undefined, onLine, shell)
}

export function toHttps(repo: string): string {
  // git@github.com:owner/name.git → https://github.com/owner/name.git
  const m = repo.match(/^git@([^:]+):(.+)$/)
  if (m) return `https://${m[1]}/${m[2]}`
  return repo
}

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
