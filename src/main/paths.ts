import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Settings } from '../shared/types'

/** ~ 를 홈 디렉토리로 확장. */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** palace 설정/사용자 매니페스트가 사는 곳. */
export const CONFIG_DIR = join(process.env.PALACE_OMP_HOME || join(homedir(), '.palace-omp'), 'catalog')
export const USER_APPS_DIR = join(CONFIG_DIR, 'apps')
export const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json')

export function ensureDirs(): void {
  for (const d of [CONFIG_DIR, USER_APPS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

const DEFAULT_SETTINGS: Settings = {
  installRoot: join(homedir(), 'LTH'),
  theme: 'dark',
  launchAtLogin: false,
  autoWireTools: false
}

export function loadSettings(): Settings {
  ensureDirs()
  try {
    if (existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
      return { ...DEFAULT_SETTINGS, ...raw }
    }
  } catch {
    // 손상된 설정은 기본값으로 폴백
  }
  return { ...DEFAULT_SETTINGS }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch }
  ensureDirs()
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2))
  return next
}

/** 설치 루트를 절대경로로. */
export function resolveInstallRoot(s: Settings): string {
  const r = expandHome(s.installRoot)
  return isAbsolute(r) ? r : join(homedir(), r)
}
