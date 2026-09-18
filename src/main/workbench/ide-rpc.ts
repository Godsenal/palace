import type { ChildProcess } from 'node:child_process'
import { spawnLongRunning } from '../exec'
import { terminateProcessGroup } from '../automation/rpc'

export interface RpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
  code?: string
}

export interface PersistentRpcOptions {
  command: string
  cwd: string
  onFrame(frame: Record<string, unknown>): void
  onStderr(text: string): void
  onExit(error?: Error): void
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

const DEFAULT_FRAME_LIMIT = 1024 * 1024
const DEFAULT_REASSEMBLY_LIMIT = 64 * 1024 * 1024
const CLOSE_GRACE_MS = 4_000

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class PersistentRpc {
  private child?: ChildProcess
  private frameLimit = DEFAULT_FRAME_LIMIT
  private reassemblyLimit = DEFAULT_REASSEMBLY_LIMIT
  private negotiatedV2 = false
  private inputBuffer = ''
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private chunk?: ChunkState
  private sequence = 0
  private closed = false
  private closing = false
  private pending = new Map<string, PendingRequest>()
  private readyResolve?: (frame: Record<string, unknown>) => void
  private readyReject?: (error: Error) => void
  private closeResolve?: () => void
  private readonly readyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })
  private readonly closePromise = new Promise<void>((resolve) => {
    this.closeResolve = resolve
  })

  constructor(private readonly options: PersistentRpcOptions) {}

  get isClosed(): boolean {
    return this.closed
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('OMP RPC 프로세스가 이미 시작되었습니다')
    const child = await spawnLongRunning(this.options.command, this.options.cwd, (line, level) => {
      if (level === 'error' && line) this.options.onStderr(line)
    })
    this.child = child
    if (!child.stdin || !child.stdout) {
      terminateProcessGroup(child)
      throw new Error('OMP RPC 표준 입출력을 열 수 없습니다')
    }

    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (this.closing && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_DESTROYED')) return
      this.fail(new Error(`OMP RPC stdin 오류: ${error.message}`))
    })
    child.stdout.on('data', (data: Buffer) => this.consume(data))
    child.on('error', (error) => this.fail(new Error(`OMP 프로세스를 시작할 수 없습니다: ${error.message}`)))
    child.on('close', (code, signal) => this.handleClose(code, signal))

    const readyTimer = setTimeout(() => this.fail(new Error('OMP RPC ready 응답 시간이 만료되었습니다')), 30_000)
    readyTimer.unref()
    try {
      const ready = await this.readyPromise
      const versions = Array.isArray(ready.supportedProtocolVersions) ? ready.supportedProtocolVersions : []
      if (versions.includes(2)) {
        await this.request('negotiate_protocol', { protocolVersion: 2 })
        this.negotiatedV2 = true
      }
    } finally {
      clearTimeout(readyTimer)
    }
  }

  request(type: string, fields: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<RpcResponse> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error('OMP RPC 명령 제한 시간이 올바르지 않습니다'))
    const id = `palace-ide-${++this.sequence}`
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${type} RPC 명령 응답 시간이 만료되었습니다`))
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ id, type, ...fields })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  send(frame: Record<string, unknown>): void {
    this.write(frame)
  }

  async shutdown(abort = false): Promise<void> {
    if (this.closed) return
    this.closing = true
    if (abort) {
      try {
        await this.request('abort', {}, 2_000)
      } catch {
        // Graceful abort is best-effort; process-group termination below is authoritative.
      }
    }
    try {
      this.child?.stdin?.end()
    } catch {
      // Stream may already be closing.
    }
    const killTimer = setTimeout(() => {
      if (this.child && !this.closed) terminateProcessGroup(this.child)
    }, CLOSE_GRACE_MS)
    killTimer.unref()
    await this.closePromise
    clearTimeout(killTimer)
  }

  private write(frame: Record<string, unknown>): void {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed || this.closed) throw new Error('종료된 OMP RPC 프로세스에 명령을 보낼 수 없습니다')
    const line = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(line, 'utf8') > this.frameLimit) throw new Error(`OMP RPC 명령이 프레임 제한(${this.frameLimit}바이트)을 초과했습니다`)
    stdin.write(line)
  }

  private consume(data: Buffer): void {
    if (this.closed) return
    try {
      this.inputBuffer += this.decoder.decode(data, { stream: true })
      if (Buffer.byteLength(this.inputBuffer, 'utf8') > this.frameLimit * 2) throw new Error('OMP RPC가 종료되지 않은 과대 프레임을 보냈습니다')
      const lines = this.inputBuffer.split('\n')
      this.inputBuffer = lines.pop() ?? ''
      for (const line of lines) this.acceptPhysicalFrame(line)
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private acceptPhysicalFrame(line: string): void {
    if (!line.trim()) return
    if (Buffer.byteLength(line, 'utf8') > this.frameLimit) throw new Error('OMP RPC 물리 프레임이 크기 제한을 초과했습니다')
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch (error) {
      throw new Error(`OMP RPC JSON 프레임을 해석할 수 없습니다: ${message(error)}`)
    }
    const frame = record(parsed)
    if (frame?.type !== 'rpc_chunk') {
      if (this.chunk) throw new Error('OMP RPC 청크 시퀀스가 다른 프레임에 의해 중단되었습니다')
      this.handleFrame(parsed)
      return
    }
    if (!this.negotiatedV2) throw new Error('OMP RPC가 v2 협상 전에 청크 프레임을 보냈습니다')
    const id = frame.chunkId
    const index = frame.index
    const count = frame.count
    const byteLength = frame.byteLength
    const encoded = frame.data
    if (typeof id !== 'string' || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) || typeof encoded !== 'string') {
      throw new Error('OMP RPC 청크 메타데이터가 올바르지 않습니다')
    }
    const numericIndex = Number(index)
    const numericCount = Number(count)
    const numericLength = Number(byteLength)
    if (numericCount < 1 || numericCount > 65_536 || numericIndex < 0 || numericIndex >= numericCount || numericLength < 0 || numericLength > this.reassemblyLimit) {
      throw new Error('OMP RPC 청크 범위가 올바르지 않습니다')
    }
    if (!this.chunk) {
      if (numericIndex !== 0) throw new Error('OMP RPC 청크 시퀀스가 0번에서 시작하지 않았습니다')
      this.chunk = { id, count: numericCount, byteLength: numericLength, nextIndex: 0, receivedBytes: 0, parts: [] }
    }
    if (this.chunk.id !== id || this.chunk.count !== numericCount || this.chunk.byteLength !== numericLength || this.chunk.nextIndex !== numericIndex) {
      throw new Error('OMP RPC 청크 시퀀스가 교차되거나 순서가 어긋났습니다')
    }
    const decoded = Buffer.from(encoded, 'base64')
    if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('OMP RPC 청크의 base64 데이터가 올바르지 않습니다')
    this.chunk.parts.push(decoded)
    this.chunk.nextIndex += 1
    this.chunk.receivedBytes += decoded.byteLength
    if (this.chunk.receivedBytes > numericLength || this.chunk.receivedBytes > this.reassemblyLimit) throw new Error('OMP RPC 청크 재조립 크기가 한도를 초과했습니다')
    if (this.chunk.nextIndex !== this.chunk.count) return
    const completed = Buffer.concat(this.chunk.parts)
    const expected = this.chunk.byteLength
    this.chunk = undefined
    if (completed.byteLength !== expected) throw new Error('OMP RPC 청크 재조립 길이가 일치하지 않습니다')
    let json: string
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(completed)
    } catch {
      throw new Error('OMP RPC 청크가 올바른 UTF-8이 아닙니다')
    }
    this.handleFrame(JSON.parse(json) as unknown)
  }

  private handleFrame(value: unknown): void {
    const frame = record(value)
    if (!frame || typeof frame.type !== 'string') throw new Error('OMP RPC가 객체가 아닌 프레임을 보냈습니다')
    if (frame.type === 'ready') {
      if (frame.protocolVersion !== 1) throw new Error(`지원하지 않는 OMP RPC ready 버전입니다: ${String(frame.protocolVersion)}`)
      if (Number.isSafeInteger(frame.maxFrameBytes) && Number(frame.maxFrameBytes) > 0) this.frameLimit = Number(frame.maxFrameBytes)
      if (Number.isSafeInteger(frame.maxReassembledFrameBytes) && Number(frame.maxReassembledFrameBytes) > 0) {
        this.reassemblyLimit = Number(frame.maxReassembledFrameBytes)
      }
      this.readyResolve?.(frame)
      this.readyResolve = undefined
      this.readyReject = undefined
      return
    }
    if (frame.type === 'response') {
      if (typeof frame.command !== 'string' || typeof frame.success !== 'boolean') throw new Error('OMP RPC response 프레임이 올바르지 않습니다')
      const response: RpcResponse = {
        id: typeof frame.id === 'string' ? frame.id : undefined,
        type: 'response',
        command: frame.command,
        success: frame.success,
        data: frame.data,
        error: typeof frame.error === 'string' ? frame.error : undefined,
        code: typeof frame.code === 'string' ? frame.code : undefined
      }
      if (response.id) {
        const pending = this.pending.get(response.id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pending.delete(response.id)
          if (response.success) pending.resolve(response)
          else pending.reject(new Error(response.error || `${response.command} RPC 명령이 실패했습니다`))
          return
        }
      }
    }
    this.options.onFrame(frame)
  }

  private fail(error: Error): void {
    if (this.closed) return
    this.readyReject?.(error)
    this.readyResolve = undefined
    this.readyReject = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.options.onStderr(error.message)
    if (this.child) terminateProcessGroup(this.child)
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return
    this.closed = true
    let tailError: Error | undefined
    try {
      this.inputBuffer += this.decoder.decode()
      if (this.inputBuffer.trim() || this.chunk) tailError = new Error(this.chunk ? 'OMP RPC가 청크 전송 중 종료되었습니다' : 'OMP RPC가 완전하지 않은 JSON 프레임을 남기고 종료되었습니다')
    } catch {
      tailError = new Error('OMP RPC stdout이 올바른 UTF-8이 아닙니다')
    }
    const error = tailError ?? (!this.closing && code !== 0 ? new Error(`OMP RPC가 종료되었습니다 (code ${code ?? signal ?? 'signal'})`) : undefined)
    this.readyReject?.(error ?? new Error('OMP RPC가 ready 전에 종료되었습니다'))
    this.readyResolve = undefined
    this.readyReject = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error ?? new Error('OMP RPC가 명령 응답 전에 종료되었습니다'))
    }
    this.pending.clear()
    this.closeResolve?.()
    this.options.onExit(error)
  }
}
