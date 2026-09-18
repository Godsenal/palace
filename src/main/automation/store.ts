import { createReadStream, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync, fsyncSync, fstatSync, readSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AutomationRun, LoopDefinition, MachineSettings, PortableProfile, RunLog } from '../../shared/automation'

export const MAX_RUN_HISTORY = 200
export const MAX_LOG_READ = 200
export const MAX_DELIVERY_HISTORY = 5_000

export interface ApprovalRecord {
  digest: string
  projectPath: string
  approvedAt: string
}

export interface TriggerCursor {
  initialized: boolean
  seen: string[]
  updatedAt: string
}

export interface StoredRun extends AutomationRun {
  definition: LoopDefinition
  omp: PortableProfile['omp']
  settings: MachineSettings
  projectPath: string
  triggerContext: string
  triggerKey?: string
}

export interface AutomationState {
  version: 1
  machineId: string
  settings: MachineSettings
  profile: PortableProfile
  approvals: Record<string, ApprovalRecord>
  schedules: Record<string, string>
  cursors: Record<string, TriggerCursor>
  eventDedupe: Record<string, string>
  webhookTokens: Record<string, string>
  webhookDeliveries: Record<string, string>
  runs: StoredRun[]
  schedulerErrors: Record<string, string>
}

export interface ServiceDescriptor {
  port: number
  token: string
  pid: number
}

export function assertSafeId(id: string, label = 'ID'): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new Error(`${label} 형식이 올바르지 않습니다`)
}

function isLogKind(value: unknown): value is RunLog['kind'] {
  return typeof value === 'string' && ['system', 'assistant', 'tool', 'check', 'error'].includes(value)
}

export function writePrivateAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path)
  chmodSync(path, 0o600)
  const directoryFd = openSync(dirname(path), 'r')
  try {
    fsyncSync(directoryFd)
  } finally {
    closeSync(directoryFd)
  }
}

export class AutomationStore {
  readonly statePath: string
  readonly logsRoot: string
  readonly descriptorPath: string
  private readonly lockPath: string
  private lockNonce?: string

  constructor(readonly root: string) {
    this.statePath = join(root, 'state.json')
    this.logsRoot = join(root, 'runs')
    this.descriptorPath = join(root, 'service.json')
    this.lockPath = join(root, 'service.lock')
  }

  ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    chmodSync(this.root, 0o700)
    mkdirSync(this.logsRoot, { recursive: true, mode: 0o700 })
    chmodSync(this.logsRoot, 0o700)
  }

  private createLock(nonce: string): boolean {
    let fd: number
    try {
      fd = openSync(this.lockPath, 'wx', 0o600)
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code === 'EEXIST') return false
      throw error
    }
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString() })}\n`, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.lockNonce = nonce
    return true
  }

  acquireLock(): void {
    this.ensureRoot()
    const nonce = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (this.createLock(nonce)) return

      let owner = 0
      try {
        const parsed: unknown = JSON.parse(readFileSync(this.lockPath, 'utf8'))
        if (parsed !== null && typeof parsed === 'object' && 'pid' in parsed && typeof parsed.pid === 'number' && Number.isSafeInteger(parsed.pid)) owner = parsed.pid
      } catch {
        owner = 0
      }
      if (owner > 0) {
        let alive = false
        try {
          process.kill(owner, 0)
          alive = true
        } catch (error) {
          const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
          if (code === 'EPERM') throw new Error(`Palace OMP 서비스 잠금을 확인할 수 없습니다 (PID ${owner})`)
          if (code !== 'ESRCH') throw error
        }
        if (alive) throw new Error(`Palace OMP 서비스가 이미 실행 중입니다 (PID ${owner})`)
      }

      const stale = `${this.lockPath}.${process.pid}.${Math.random().toString(36).slice(2)}.stale`
      try {
        renameSync(this.lockPath, stale)
      } catch (error) {
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
        if (code === 'ENOENT') continue
        throw error
      }
      try {
        if (this.createLock(nonce)) return
      } finally {
        rmSync(stale, { force: true })
      }
    }
    throw new Error('Palace OMP 서비스 잠금을 획득하지 못했습니다')
  }

  releaseLock(): void {
    if (!this.lockNonce) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.lockPath, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && 'nonce' in parsed && parsed.nonce === this.lockNonce) {
        rmSync(this.lockPath, { force: true })
      }
    } catch {
      // 다른 프로세스의 잠금일 수 있으므로 알 수 없는 파일은 지우지 않는다.
    }
    this.lockNonce = undefined
  }

  loadState(): unknown | undefined {
    if (!existsSync(this.statePath)) return undefined
    return JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown
  }

  saveState(state: AutomationState): void {
    writePrivateAtomic(this.statePath, state)
  }

  writeDescriptor(descriptor: ServiceDescriptor): void {
    writePrivateAtomic(this.descriptorPath, descriptor)
  }

  readDescriptor(): ServiceDescriptor | undefined {
    if (!existsSync(this.descriptorPath)) return undefined
    try {
      const value: unknown = JSON.parse(readFileSync(this.descriptorPath, 'utf8'))
      if (value === null || typeof value !== 'object' || !('port' in value) || !('token' in value) || !('pid' in value)) return undefined
      if (typeof value.port !== 'number' || typeof value.token !== 'string' || typeof value.pid !== 'number') return undefined
      return { port: value.port, token: value.token, pid: value.pid }
    } catch {
      return undefined
    }
  }

  removeDescriptor(ownerPid?: number): void {
    if (ownerPid !== undefined && this.readDescriptor()?.pid !== ownerPid) return
    rmSync(this.descriptorPath, { force: true })
  }

  appendLog(runId: string, log: RunLog): void {
    assertSafeId(runId, '실행 ID')
    const path = join(this.logsRoot, `${runId}.jsonl`)
    const textBytes = Buffer.from(log.text, 'utf8')
    const text = textBytes.byteLength > 64 * 1024
      ? `${textBytes.subarray(0, 64 * 1024).toString('utf8')}\n[로그가 제한 길이에서 잘렸습니다]`
      : log.text
    const fd = openSync(path, 'a', 0o600)
    try {
      writeFileSync(fd, `${JSON.stringify({ ...log, text })}\n`, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    chmodSync(path, 0o600)
  }

  lastLogSeq(runId: string): number {
    assertSafeId(runId, '실행 ID')
    const path = join(this.logsRoot, `${runId}.jsonl`)
    if (!existsSync(path)) return 0
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, 512 * 1024)
      const buffer = Buffer.allocUnsafe(length)
      readSync(fd, buffer, 0, length, size - length)
      const lines = buffer.toString('utf8').split('\n')
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index]) continue
        try {
          const parsed: unknown = JSON.parse(lines[index])
          if (parsed !== null && typeof parsed === 'object' && 'seq' in parsed && typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq)) return parsed.seq
        } catch {
          // 읽기 창 첫 줄이 중간에서 시작했거나 손상된 줄이면 이전 줄을 계속 찾는다.
        }
      }
      return 0
    } finally {
      closeSync(fd)
    }
  }

  async readLogs(runId: string, after = 0, limit = MAX_LOG_READ): Promise<RunLog[]> {
    assertSafeId(runId, '실행 ID')

    if (!Number.isSafeInteger(after) || after < 0) throw new Error('로그 커서가 올바르지 않습니다')
    const boundedLimit = Math.max(1, Math.min(MAX_LOG_READ, Math.floor(limit)))
    const path = join(this.logsRoot, `${runId}.jsonl`)
    if (!existsSync(path)) return []

    const logs: RunLog[] = []
    const input = createReadStream(path, { encoding: 'utf8' })
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (!line || line.length > 512 * 1024) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line) as unknown
        } catch {
          continue
        }
        if (parsed === null || typeof parsed !== 'object' || !('seq' in parsed) || typeof parsed.seq !== 'number' || !Number.isSafeInteger(parsed.seq)) continue
        if (!('at' in parsed) || typeof parsed.at !== 'string' || !('kind' in parsed) || !isLogKind(parsed.kind) || !('text' in parsed) || typeof parsed.text !== 'string') continue
        const log: RunLog = { seq: parsed.seq, at: parsed.at, kind: parsed.kind, text: parsed.text }
        if (log.seq > after) logs.push(log)
        if (logs.length >= boundedLimit) {
          lines.close()
          input.destroy()
          break
        }
      }
    } finally {
      lines.close()
      input.destroy()
    }
    return logs
  }

  deleteLogs(runId: string): void {
    assertSafeId(runId, '실행 ID')
    rmSync(join(this.logsRoot, `${runId}.jsonl`), { force: true })
  }
}
