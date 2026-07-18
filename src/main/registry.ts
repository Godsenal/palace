import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { BUILTIN_MANIFESTS } from '../shared/manifests'
import type { Manifest, Settings } from '../shared/types'
import { USER_APPS_DIR, ensureDirs, expandHome, resolveInstallRoot } from './paths'
import { isGitRepo } from './git'

/** 내장 + 사용자(~/.palace/apps/*.json) 매니페스트. 같은 id 는 사용자 것이 우선. */
export function loadManifests(): Manifest[] {
  ensureDirs()
  const byId = new Map<string, Manifest>()
  for (const m of BUILTIN_MANIFESTS) byId.set(m.id, { ...m, builtin: true })
  try {
    for (const f of readdirSync(USER_APPS_DIR)) {
      if (!f.endsWith('.json')) continue
      try {
        const m = JSON.parse(readFileSync(join(USER_APPS_DIR, f), 'utf8')) as Manifest
        if (m && m.id) byId.set(m.id, { ...m, builtin: false })
      } catch {
        // 잘못된 매니페스트 파일은 건너뜀
      }
    }
  } catch {
    /* noop */
  }
  return [...byId.values()]
}

export function getManifest(id: string): Manifest | undefined {
  return loadManifests().find((m) => m.id === id)
}

export function saveUserManifest(m: Manifest): void {
  ensureDirs()
  writeFileSync(join(USER_APPS_DIR, `${m.id}.json`), JSON.stringify({ ...m, builtin: false }, null, 2))
}

export function removeUserManifest(id: string): void {
  const f = join(USER_APPS_DIR, `${id}.json`)
  if (existsSync(f)) unlinkSync(f)
}

/**
 * 매니페스트의 설치 위치를 해석한다.
 * 1) detectPaths 중 실제 존재하는 첫 경로
 * 2) 없으면 installRoot/id (아직 없을 수 있음)
 * installed = 그 디렉토리가 git repo 로 존재하는가.
 */
export function resolveDir(m: Manifest, settings: Settings): { dir: string; installed: boolean } {
  for (const p of m.detectPaths ?? []) {
    const abs = expandHome(p)
    if (existsSync(abs) && isGitRepo(abs)) return { dir: abs, installed: true }
  }
  const fallback = join(resolveInstallRoot(settings), m.id)
  return { dir: fallback, installed: existsSync(fallback) && isGitRepo(fallback) }
}
