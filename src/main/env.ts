import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { EnvEntry } from '../shared/types'

const SECRET_RE = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|VAPID|AUTH|CREDENTIAL|PRIVATE)/i

export function isSecretKey(key: string, extra?: string[]): boolean {
  if (SECRET_RE.test(key)) return true
  return (extra ?? []).some((p) => {
    try {
      return new RegExp(p, 'i').test(key)
    } catch {
      return false
    }
  })
}

/** KEY=VALUE 라인만 파싱(주석/공백 무시). 편집 UI 표시용. */
export function parseEnv(file: string, secretKeys?: string[]): EnvEntry[] {
  if (!existsSync(file)) return []
  const out: EnvEntry[] = []
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    // 따옴표 제거
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out.push({ key, value, secret: isSecretKey(key, secretKeys) })
  }
  return out
}

/**
 * entries 를 파일에 반영하되 기존 주석/공백/순서를 최대한 보존.
 * 존재하던 키는 제자리에서 값 갱신, 새 키는 끝에 추가, 사라진 키는 삭제.
 */
export function writeEnv(file: string, entries: EnvEntry[]): void {
  const want = new Map(entries.map((e) => [e.key, e.value]))
  const seen = new Set<string>()
  const origLines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
  const outLines: string[] = []

  for (const raw of origLines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) {
      outLines.push(raw)
      continue
    }
    const eq = line.indexOf('=')
    const key = eq > 0 ? line.slice(0, eq).trim().replace(/^export\s+/, '') : ''
    if (key && want.has(key)) {
      outLines.push(`${key}=${serialize(want.get(key)!)}`)
      seen.add(key)
    } else if (key && !want.has(key)) {
      // 삭제된 키 — 라인 제거
      continue
    } else {
      outLines.push(raw)
    }
  }
  // 새 키 추가
  const added = entries.filter((e) => !seen.has(e.key))
  if (added.length) {
    if (outLines.length && outLines[outLines.length - 1].trim() !== '') outLines.push('')
    for (const e of added) outLines.push(`${e.key}=${serialize(e.value)}`)
  }
  let content = outLines.join('\n')
  if (!content.endsWith('\n')) content += '\n'
  writeFileSync(file, content)
}

function serialize(v: string): string {
  // 공백/특수문자 있으면 따옴표
  return /[\s#'"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v
}
