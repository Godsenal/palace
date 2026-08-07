import { existsSync, statSync, unlinkSync } from 'node:fs'
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
  await clearStaleIndexLock(dir, shell)
  await runCapture('git fetch --quiet', dir, shell, 90_000)
  await ensureUpstream(dir, shell)
  return gitInfo(dir, shell)
}

/** 이 시간보다 오래된 index.lock 은 살아있는 git 의 것이 아니라고 본다(정상 락은 수백 ms). */
const STALE_LOCK_MS = 60_000

/**
 * 죽은 `.git/index.lock` 을 치운다. 지웠으면 true.
 *
 * runCapture 는 타임아웃에 SIGKILL 을 날리고, 앱이 꺼지면 자식 git 도 같이 죽는다. 그 순간
 * index 를 쓰던 git(`git status` 등)이 락을 남기면, 그 repo 의 `git pull --ff-only` 는
 * 손으로 락을 지울 때까지 영원히 exit 1 이다 — 업데이트 버튼이 계속 실패하는 실제 원인.
 * 오래됐고(STALE_LOCK_MS) 아무 프로세스도 열고 있지 않은 락만 지운다(느린 git 은 보호).
 */
export async function clearStaleIndexLock(dir: string, shell?: string): Promise<boolean> {
  if (!isGitRepo(dir)) return false
  // worktree/서브모듈은 .git 이 파일이라 경로가 다르다 → git 에게 실제 gitdir 을 묻는다.
  const gitDir = (await runCapture('git rev-parse --absolute-git-dir', dir, shell)).stdout.trim()
  if (!gitDir) return false
  const lock = join(gitDir, 'index.lock')
  let ageMs: number
  try {
    ageMs = Date.now() - statSync(lock).mtimeMs
  } catch {
    return false // 락 없음 — 정상
  }
  if (ageMs < STALE_LOCK_MS) return false // 방금 생긴 락 = 지금 돌고 있는 git 일 수 있음
  // git 은 rename 전까지 락 fd 를 열어둔다 → 잡고 있는 프로세스가 있으면 살아있는 것.
  const held = await runCapture(`lsof -t ${quote(lock)}`, dir, shell, 10_000)
  if (held.stdout.trim()) return false
  try {
    unlinkSync(lock)
    return true
  } catch {
    return false
  }
}

/**
 * 현재 브랜치에 upstream(추적 브랜치)이 없으면 `origin/<branch>` 로 설정한다.
 *
 * palace 로 clone 하지 않고 미리 존재하던 repo(detectPaths) 나, tracking 없이 셋업된
 * repo 에서 `git pull --ff-only` 가 "There is no tracking information..." 로 exit 1 나는 걸
 * 막는다. `@{u}` 에 의존하는 behind/ahead 감지(gitInfo)도 같이 살아난다.
 * 이미 upstream 이 있거나 git repo 가 아니거나 detached HEAD 면 아무것도 안 한다(멱등).
 */
export async function ensureUpstream(dir: string, shell?: string): Promise<void> {
  if (!isGitRepo(dir)) return
  // 이미 upstream 설정돼 있으면 skip
  const has = await runCapture('git rev-parse --abbrev-ref --symbolic-full-name @{u}', dir, shell)
  if (has.code === 0 && has.stdout.trim()) return
  const br = (await runCapture('git rev-parse --abbrev-ref HEAD', dir, shell)).stdout.trim()
  if (!br || br === 'HEAD') return // detached HEAD — 손대지 않음
  const originRef = `refs/remotes/origin/${br}`
  let ref = await runCapture(`git show-ref --verify --quiet ${quote(originRef)}`, dir, shell)
  if (ref.code !== 0) {
    // 원격추적 ref 가 아직 없으면 한 번 fetch(최초 셋업 케이스)
    await runCapture('git fetch origin --quiet', dir, shell, 90_000)
    ref = await runCapture(`git show-ref --verify --quiet ${quote(originRef)}`, dir, shell)
  }
  if (ref.code === 0) {
    await runCapture(`git branch --set-upstream-to=${quote('origin/' + br)} ${quote(br)}`, dir, shell)
  }
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
