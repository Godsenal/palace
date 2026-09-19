import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { MachineSettings, PortableProfile } from '../../shared/automation'
import type { AgentProfile, OmpAPI } from '../../shared/workbench'
import { spawnLongRunning } from '../exec'
import { parentWatchedCommand, redactLogText, shellCommand, terminateProcessGroup } from '../automation/rpc'
import { validateAgentProfiles } from './profile'
import { materializeSessionRuntime } from './session-runtime'

const PROFILE_VERSION = 1
const DEFAULT_FRAME_LIMIT = 1024 * 1024
const DEFAULT_REASSEMBLY_LIMIT = 64 * 1024 * 1024

type Model = { id: string; name: string; provider: string }

interface StoredProfiles {
  version: 1
  profiles: AgentProfile[]
}

interface OmpServiceOptions {
  root: string
  getSettings(): MachineSettings
  getOmp(): PortableProfile['omp']
}

interface RpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
}

interface PendingRequest {
  resolve(response: RpcResponse): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

interface ChunkState {
  id: string
  count: number
  byteLength: number
  nextIndex: number
  receivedBytes: number
  parts: Buffer[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function closeRpc(child: ChildProcess, closed: Promise<void>): Promise<void> {
  try { child.stdin?.end() } catch { /* already closing */ }
  if (await Promise.race([closed.then(() => true), delay(4_000).then(() => false)])) return
  terminateProcessGroup(child)
  await Promise.race([closed, delay(1_000)])
}

async function requestModels(command: string, cwd: string): Promise<unknown> {
  let stderr = ''
  const child = await spawnLongRunning(command, cwd, (line, level) => {
    if (level === 'error' && line) stderr = `${stderr}${redactLogText(line)}\n`.slice(-32_768)
  })
  if (!child.stdin || !child.stdout) {
    terminateProcessGroup(child)
    throw new Error('OMP RPC 표준 입출력을 열 수 없습니다')
  }

  let frameLimit = DEFAULT_FRAME_LIMIT
  let reassemblyLimit = DEFAULT_REASSEMBLY_LIMIT
  let negotiatedV2 = false
  let inputBuffer = ''
  let sequence = 0
  let chunk: ChunkState | undefined
  let closed = false
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const pending = new Map<string, PendingRequest>()
  let resolveReady!: (frame: Record<string, unknown>) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise
    rejectReady = rejectPromise
  })
  let resolveClosed!: () => void
  const closedPromise = new Promise<void>((resolvePromise) => { resolveClosed = resolvePromise })

  const fail = (error: Error): void => {
    if (closed) return
    rejectReady(error)
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
    terminateProcessGroup(child)
  }

  const handleFrame = (value: unknown): void => {
    const frame = record(value)
    if (!frame || typeof frame.type !== 'string') throw new Error('OMP RPC가 객체가 아닌 프레임을 보냈습니다')
    if (frame.type === 'ready') {
      if (frame.protocolVersion !== 1) throw new Error(`지원하지 않는 OMP RPC ready 버전입니다: ${String(frame.protocolVersion)}`)
      if (Number.isSafeInteger(frame.maxFrameBytes) && Number(frame.maxFrameBytes) > 0) frameLimit = Number(frame.maxFrameBytes)
      if (Number.isSafeInteger(frame.maxReassembledFrameBytes) && Number(frame.maxReassembledFrameBytes) > 0) reassemblyLimit = Number(frame.maxReassembledFrameBytes)
      resolveReady(frame)
      return
    }
    if (frame.type !== 'response' || typeof frame.command !== 'string' || typeof frame.success !== 'boolean') return
    const id = typeof frame.id === 'string' ? frame.id : undefined
    const request = id ? pending.get(id) : undefined
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(id!)
    const response: RpcResponse = {
      id,
      type: 'response',
      command: frame.command,
      success: frame.success,
      data: frame.data,
      error: typeof frame.error === 'string' ? frame.error : undefined
    }
    if (response.success) request.resolve(response)
    else request.reject(new Error(response.error || `${response.command} RPC 명령이 실패했습니다`))
  }

  const acceptFrame = (line: string): void => {
    if (!line.trim()) return
    if (Buffer.byteLength(line, 'utf8') > frameLimit) throw new Error('OMP RPC 물리 프레임이 크기 제한을 초과했습니다')
    let value: unknown
    try { value = JSON.parse(line) as unknown } catch (error) { throw new Error(`OMP RPC JSON 프레임을 해석할 수 없습니다: ${message(error)}`) }
    const frame = record(value)
    if (frame?.type !== 'rpc_chunk') {
      if (chunk) throw new Error('OMP RPC 청크 시퀀스가 다른 프레임에 의해 중단되었습니다')
      handleFrame(value)
      return
    }
    if (!negotiatedV2) throw new Error('OMP RPC가 v2 협상 전에 청크 프레임을 보냈습니다')
    const id = frame.chunkId
    const index = frame.index
    const count = frame.count
    const byteLength = frame.byteLength
    const encoded = frame.data
    if (typeof id !== 'string' || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) || typeof encoded !== 'string') throw new Error('OMP RPC 청크 메타데이터가 올바르지 않습니다')
    const numericIndex = Number(index)
    const numericCount = Number(count)
    const numericLength = Number(byteLength)
    if (numericCount < 1 || numericCount > 65_536 || numericIndex < 0 || numericIndex >= numericCount || numericLength < 0 || numericLength > reassemblyLimit) throw new Error('OMP RPC 청크 범위가 올바르지 않습니다')
    if (!chunk) {
      if (numericIndex !== 0) throw new Error('OMP RPC 청크 시퀀스가 0번에서 시작하지 않았습니다')
      chunk = { id, count: numericCount, byteLength: numericLength, nextIndex: 0, receivedBytes: 0, parts: [] }
    }
    if (chunk.id !== id || chunk.count !== numericCount || chunk.byteLength !== numericLength || chunk.nextIndex !== numericIndex) throw new Error('OMP RPC 청크 시퀀스가 교차되거나 순서가 어긋났습니다')
    const decoded = Buffer.from(encoded, 'base64')
    if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('OMP RPC 청크의 base64 데이터가 올바르지 않습니다')
    chunk.parts.push(decoded)
    chunk.nextIndex += 1
    chunk.receivedBytes += decoded.byteLength
    if (chunk.receivedBytes > numericLength || chunk.receivedBytes > reassemblyLimit) throw new Error('OMP RPC 청크 재조립 크기가 한도를 초과했습니다')
    if (chunk.nextIndex !== chunk.count) return
    const completed = Buffer.concat(chunk.parts)
    const expected = chunk.byteLength
    chunk = undefined
    if (completed.byteLength !== expected) throw new Error('OMP RPC 청크 재조립 길이가 일치하지 않습니다')
    handleFrame(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(completed)) as unknown)
  }

  const request = (type: string, fields: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<RpcResponse> => {
    const id = `palace-omp-${++sequence}`
    return new Promise<RpcResponse>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectPromise(new Error(`${type} RPC 명령 응답 시간이 만료되었습니다`))
      }, timeoutMs)
      timer.unref()
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
      try {
        const line = `${JSON.stringify({ id, type, ...fields })}\n`
        if (Buffer.byteLength(line, 'utf8') > frameLimit) throw new Error('OMP RPC 명령이 프레임 제한을 초과했습니다')
        child.stdin!.write(line)
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        rejectPromise(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (!closed && error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') fail(new Error(`OMP RPC stdin 오류: ${error.message}`))
  })
  child.stdout.on('data', (data: Buffer) => {
    if (closed) return
    try {
      inputBuffer += decoder.decode(data, { stream: true })
      if (Buffer.byteLength(inputBuffer, 'utf8') > frameLimit * 2) throw new Error('OMP RPC가 종료되지 않은 과대 프레임을 보냈습니다')
      const lines = inputBuffer.split('\n')
      inputBuffer = lines.pop() ?? ''
      for (const line of lines) acceptFrame(line)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
  child.on('error', (error) => fail(new Error(`OMP 프로세스를 시작할 수 없습니다: ${error.message}`)))
  child.on('close', (code, signal) => {
    if (closed) return
    closed = true
    const error = new Error(`OMP RPC가 응답 전에 종료되었습니다 (code ${code ?? signal ?? 'signal'})${stderr ? `: ${stderr.trim()}` : ''}`)
    rejectReady(error)
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
    resolveClosed()
  })

  const readyTimer = setTimeout(() => fail(new Error('OMP RPC ready 응답 시간이 만료되었습니다')), 30_000)
  readyTimer.unref()
  try {
    const readyFrame = await ready
    clearTimeout(readyTimer)
    const versions = Array.isArray(readyFrame.supportedProtocolVersions) ? readyFrame.supportedProtocolVersions : []
    if (versions.includes(2)) {
      await request('negotiate_protocol', { protocolVersion: 2 })
      negotiatedV2 = true
    }
    return (await request('get_available_models')).data
  } finally {
    clearTimeout(readyTimer)
    await closeRpc(child, closedPromise)
  }
}

export class OmpService implements OmpAPI {
  private readonly directory: string
  private readonly profilePath: string
  private readonly legacyStatePath: string
  private readonly runtimeDirectory: string
  private initialized = false
  private values: AgentProfile[] = []
  private persistence: Promise<void> = Promise.resolve()
  private modelCache?: { at: number; value: Model[] }
  private modelLoading?: Promise<Model[]>

  constructor(private readonly options: OmpServiceOptions) {
    this.directory = join(resolve(options.root), 'workbench')
    this.profilePath = join(this.directory, 'profiles.json')
    this.legacyStatePath = join(this.directory, 'state.json')
    this.runtimeDirectory = join(this.directory, 'omp-runtime')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const stored = record(JSON.parse(await readFile(this.profilePath, 'utf8')))
      if (!stored || stored.version !== PROFILE_VERSION || Object.keys(stored).some((key) => key !== 'version' && key !== 'profiles')) throw new Error('지원하지 않는 프로필 저장 형식입니다')
      this.values = validateAgentProfiles(stored.profiles)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`OMP 프로필을 읽을 수 없습니다: ${message(error)}`)
      await this.migrateLegacyProfiles()
    }
    this.initialized = true
  }

  async models(): Promise<Model[]> {
    this.assertInitialized()
    if (this.modelCache && Date.now() - this.modelCache.at < 30_000) return clone(this.modelCache.value)
    if (!this.modelLoading) {
      this.modelLoading = this.discoverModels().then((value) => {
        this.modelCache = { at: Date.now(), value }
        return value
      }).finally(() => { this.modelLoading = undefined })
    }
    return clone(await this.modelLoading)
  }

  async profiles(): Promise<AgentProfile[]> {
    this.assertInitialized()
    return clone(validateAgentProfiles(this.values))
  }

  async saveProfiles(profiles: AgentProfile[]): Promise<void> {
    this.assertInitialized()
    const validated = validateAgentProfiles(profiles)
    const operation = this.persistence.then(async () => {
      await this.writeProfiles(validated)
      this.values = clone(validated)
    })
    this.persistence = operation.catch(() => undefined)
    await operation
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('OmpService.initialize()를 먼저 호출해야 합니다')
  }

  private async migrateLegacyProfiles(): Promise<void> {
    try {
      const legacy = record(JSON.parse(await readFile(this.legacyStatePath, 'utf8')))
      if (!legacy || legacy.version !== 1 || !Object.hasOwn(legacy, 'profiles')) throw new Error('지원하지 않는 기존 워크벤치 상태 형식입니다')
      const profiles = validateAgentProfiles(legacy.profiles)
      await this.writeProfiles(profiles)
      this.values = clone(profiles)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.values = []
        return
      }
      throw new Error(`기존 워크벤치 상태에서 OMP 프로필을 이전할 수 없습니다: ${message(error)}`)
    }
  }

  private async writeProfiles(profiles: AgentProfile[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.profilePath}.${process.pid}.${randomUUID()}.tmp`
    const stored: StoredProfiles = { version: PROFILE_VERSION, profiles: clone(profiles) }
    try {
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.profilePath)
      await chmod(this.profilePath, 0o600)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async discoverModels(): Promise<Model[]> {
    const settings = this.options.getSettings()
    const ompCommand = settings.ompCommand.trim()
    if (!ompCommand) throw new Error('OMP 명령이 구성되지 않았습니다')
    const discoveryId = `models-${randomUUID()}`
    const runtime = await materializeSessionRuntime({
      runtimeRoot: this.runtimeDirectory,
      sessionId: discoveryId,
      workspaceCwd: resolve(this.options.root),
      omp: this.options.getOmp()
    })
    const args = [ompCommand, '--mode', 'rpc', '--config', runtime.configPath, '--no-session', '--no-title']
    if (runtime.instructionsPath) args.push('--append-system-prompt', runtime.instructionsPath)
    try {
      const data = await requestModels(parentWatchedCommand(shellCommand(args)), resolve(this.options.root))
      return this.normalizeModels(data)
    } finally {
      await rm(runtime.directory, { recursive: true, force: true })
    }
  }

  private normalizeModels(data: unknown): Model[] {
    const models = record(data)?.models
    if (!Array.isArray(models)) throw new Error('OMP 모델 목록 응답이 올바르지 않습니다')
    const result: Model[] = []
    const seen = new Set<string>()
    for (const item of models) {
      const row = record(item)
      if (!row || typeof row.id !== 'string' || typeof row.provider !== 'string') continue
      const key = `${row.provider}/${row.id}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({ id: row.id, name: typeof row.name === 'string' && row.name ? row.name : row.id, provider: row.provider })
    }
    return result.sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name))
  }
}
