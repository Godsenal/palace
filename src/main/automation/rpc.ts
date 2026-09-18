import type { ChildProcess } from 'node:child_process'
import { spawnLongRunning } from '../exec'

export type RunnerLogKind = 'system' | 'assistant' | 'tool' | 'check' | 'error'

export interface RpcAttemptOptions {
  command: string
  cwd: string
  prompt: string
  timeoutMs: number
  signal: AbortSignal
  onLog(kind: RunnerLogKind, text: string): void
}

export interface RpcAttemptResult {
  sessionFile?: string
  summary: string
}

interface RpcResponse {
  id?: string
  type: 'response'
  command: string
  success: boolean
  data?: unknown
  error?: string
  code?: string
}

interface PendingCommand {
  resolve(response: RpcResponse): void
  reject(error: Error): void
}

interface PromptState extends PendingCommand {
  id: string
  acknowledged: boolean
  terminal: boolean
  settled: boolean
}

interface ChunkState {
  id: string
  count: number
  byteLength: number
  parts: Buffer[]
  nextIndex: number
  receivedBytes: number
}

const DEFAULT_FRAME_LIMIT = 1024 * 1024
const DEFAULT_REASSEMBLY_LIMIT = 64 * 1024 * 1024
const SHUTDOWN_GRACE_MS = 4_000

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function shellCommand(argv: string[]): string {
  if (argv.length === 0) throw new Error('실행할 명령이 없습니다')
  return argv.map(shellQuote).join(' ')
}

/**
 * spawnLongRunning의 분리된 프로세스 그룹이 Palace 서비스보다 오래 살지 않도록 한다.
 * 부모 PID가 사라지면 같은 그룹의 OMP/점검 자식 전체에 TERM 후 KILL을 보낸다.
 */
export function parentWatchedCommand(command: string): string {
  const ownerPid = process.pid
  return [
    `PALACE_OMP_OWNER_PID=${shellQuote(String(ownerPid))}`,
    '(while kill -0 "$PALACE_OMP_OWNER_PID" 2>/dev/null; do sleep 1; done; kill -TERM -- "-$$" 2>/dev/null; sleep 4; kill -KILL -- "-$$" 2>/dev/null) &',
    'PALACE_OMP_WATCHDOG_PID=$!',
    `trap 'kill "$PALACE_OMP_WATCHDOG_PID" 2>/dev/null; wait "$PALACE_OMP_WATCHDOG_PID" 2>/dev/null' EXIT`,
    command
  ].join('\n')
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function redactLogText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1[REDACTED]')
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1[REDACTED]@')
}

export function terminateProcessGroup(child: ChildProcess): void {
  const pid = child.pid
  if (!pid) return
  let termSent = false
  try {
    process.kill(-pid, 'SIGTERM')
    termSent = true
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        termSent = child.kill('SIGTERM')
      } catch {
        // 이미 종료되었다.
      }
    }
  }
  if (!termSent) return
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // 이미 종료되었다.
        }
      }
    }
  }, SHUTDOWN_GRACE_MS)
  timer.unref()
}

function extractSummary(data: unknown): string {
  if (typeof data === 'string') return data
  const record = asRecord(data)
  if (!record) return ''
  for (const key of ['text', 'message', 'content']) {
    if (typeof record[key] === 'string') return record[key] as string
  }
  return ''
}

function toolSummary(frame: Record<string, unknown>): string {
  const toolName = typeof frame.toolName === 'string' ? frame.toolName : 'unknown'
  const args = asRecord(frame.args) ?? asRecord(frame.input)
  if (!args) return toolName
  if (typeof args.path === 'string') return `${toolName} (${redactLogText(args.path).slice(0, 240)})`
  if (typeof args.command === 'string') return `${toolName} (${redactLogText(args.command).replace(/\s+/g, ' ').slice(0, 240)})`
  return toolName
}

export async function runRpcAttempt(options: RpcAttemptOptions): Promise<RpcAttemptResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('OMP 실행 시간이 만료되었습니다')
  if (options.signal.aborted) throw new Error('OMP 실행이 취소되었습니다')

  let stderr = ''
  const child = await spawnLongRunning(options.command, options.cwd, (line, level) => {
    if (level === 'error') {
      const safe = redactLogText(line)
      stderr = `${stderr}${safe}\n`.slice(-32_768)
      options.onLog('error', safe)
    }
  })
  if (options.signal.aborted) {
    terminateProcessGroup(child)
    throw new Error('OMP 실행이 취소되었습니다')
  }
  if (!child.stdin || !child.stdout) {
    terminateProcessGroup(child)
    throw new Error('OMP RPC 표준 입출력을 열 수 없습니다')
  }
  const stdin = child.stdin
  const stdout = child.stdout

  let frameLimit = DEFAULT_FRAME_LIMIT
  let reassemblyLimit = DEFAULT_REASSEMBLY_LIMIT
  let ready = false
  let negotiatedV2 = false
  let stdoutBuffer = ''
  const stdoutDecoder = new TextDecoder('utf-8', { fatal: true })
  let chunk: ChunkState | undefined
  let assistantBuffer = ''
  let commandSeq = 0
  let prompt: PromptState | undefined
  let fatal: Error | undefined
  let closed = false
  let closeCode: number | null = null
  const pending = new Map<string, PendingCommand>()

  let resolveReady!: (frame: Record<string, unknown>) => void
  let rejectReady!: (error: Error) => void
  const readyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  let resolveClosed!: () => void
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  const flushAssistant = (): void => {
    const text = assistantBuffer.trim()
    assistantBuffer = ''
    if (text) options.onLog('assistant', text)
  }

  const failAll = (error: Error): void => {
    if (fatal) return
    fatal = error
    rejectReady(error)
    if (prompt && !prompt.settled) {
      prompt.settled = true
      prompt.reject(error)
    }
    for (const item of pending.values()) item.reject(error)
    pending.clear()
  }

  stdin.on('error', (error: Error) => {
    const code = (error as NodeJS.ErrnoException).code
    if ((code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') && (fatal || closed)) return
    failAll(new Error(`OMP RPC stdin 오류: ${error.message}`))
    terminateProcessGroup(child)
  })

  const writeFrame = (frame: Record<string, unknown>): void => {
    if (closed || stdin.destroyed) throw new Error('종료된 OMP RPC 프로세스에 명령을 보낼 수 없습니다')
    const line = `${JSON.stringify(frame)}\n`
    if (Buffer.byteLength(line, 'utf8') > frameLimit) throw new Error(`OMP RPC 명령이 프레임 제한(${frameLimit}바이트)을 초과했습니다`)
    stdin.write(line)
  }

  const maybeCompletePrompt = (): void => {
    if (!prompt || prompt.settled || !prompt.acknowledged || !prompt.terminal) return
    prompt.settled = true
    prompt.resolve({ id: prompt.id, type: 'response', command: 'prompt', success: true })
  }

  const handleFrame = (value: unknown): void => {
    const frame = asRecord(value)
    if (!frame || typeof frame.type !== 'string') throw new Error('OMP RPC가 객체가 아닌 프레임을 보냈습니다')

    if (frame.type === 'ready') {
      if (ready) throw new Error('OMP RPC ready 프레임이 중복되었습니다')
      if (frame.protocolVersion !== 1) throw new Error(`지원하지 않는 OMP RPC ready 버전입니다: ${String(frame.protocolVersion)}`)
      ready = true
      if (Number.isSafeInteger(frame.maxFrameBytes) && Number(frame.maxFrameBytes) > 0) frameLimit = Number(frame.maxFrameBytes)
      if (Number.isSafeInteger(frame.maxReassembledFrameBytes) && Number(frame.maxReassembledFrameBytes) > 0) {
        reassemblyLimit = Number(frame.maxReassembledFrameBytes)
      }
      resolveReady(frame)
      return
    }

    if (!ready) throw new Error('OMP RPC가 ready 이전에 데이터를 보냈습니다')

    if (frame.type === 'response') {
      if (
        typeof frame.command !== 'string' ||
        typeof frame.success !== 'boolean' ||
        (frame.id !== undefined && typeof frame.id !== 'string') ||
        (frame.error !== undefined && typeof frame.error !== 'string') ||
        (frame.code !== undefined && typeof frame.code !== 'string')
      ) {
        throw new Error('OMP RPC response 프레임이 올바르지 않습니다')
      }
      const response: RpcResponse = {
        id: frame.id,
        type: 'response',
        command: frame.command,
        success: frame.success,
        data: frame.data,
        error: frame.error,
        code: frame.code
      }
      if (response.id && prompt?.id === response.id && response.command === 'prompt') {
        if (!response.success) {
          if (!prompt.settled) {
            prompt.settled = true
            prompt.reject(new Error(response.error || 'OMP 프롬프트 실행에 실패했습니다'))
          }
          return
        }
        const data = asRecord(response.data)
        if (data?.agentInvoked === false) {
          if (!prompt.settled) {
            prompt.settled = true
            prompt.reject(new Error('OMP 프롬프트가 에이전트를 실행하지 않았습니다'))
          }
          return
        }
        prompt.acknowledged = true
        maybeCompletePrompt()
        return
      }

      if (response.id) {
        const item = pending.get(response.id)
        if (item) {
          pending.delete(response.id)
          if (response.success) item.resolve(response)
          else item.reject(new Error(response.error || `${response.command} RPC 명령이 실패했습니다`))
          return
        }
      }
      if (!response.success) options.onLog('error', redactLogText(response.error || `${response.command} RPC 오류`))
      return
    }

    if (frame.type === 'agent_end') {
      flushAssistant()
      if (frame.isTerminal !== false && prompt && !prompt.settled) {
        prompt.terminal = true
        maybeCompletePrompt()
      }
      return
    }

    if (frame.type === 'prompt_result' && prompt && frame.id === prompt.id && frame.agentInvoked === false && !prompt.settled) {
      prompt.settled = true
      prompt.reject(new Error('OMP 프롬프트가 에이전트 턴 없이 종료되었습니다'))
      return
    }

    if (frame.type === 'message_update') {
      const event = asRecord(frame.assistantMessageEvent)
      if (event?.type === 'text_delta' && typeof event.delta === 'string') {
        assistantBuffer += event.delta
        const newline = assistantBuffer.lastIndexOf('\n')
        if (newline >= 0) {
          const complete = assistantBuffer.slice(0, newline).trim()
          assistantBuffer = assistantBuffer.slice(newline + 1)
          if (complete) options.onLog('assistant', complete)
        } else if (assistantBuffer.length >= 1_500) {
          flushAssistant()
        }
      }
      return
    }

    if (frame.type === 'message_end') {
      flushAssistant()
      return
    }

    if (frame.type === 'tool_execution_start') {
      options.onLog('tool', `도구 시작: ${toolSummary(frame)}`)
      return
    }

    if (frame.type === 'tool_execution_end') {
      const suffix = frame.isError === true ? '실패' : '완료'
      options.onLog('tool', `도구 ${suffix}: ${toolSummary(frame)}`)
      return
    }

    if (frame.type === 'extension_error') {
      const error = new Error(`OMP 정책 확장 오류: ${redactLogText(String(frame.error ?? '알 수 없는 오류'))}`)
      options.onLog('error', error.message)
      failAll(error)
      terminateProcessGroup(child)
      return
    }

    if (frame.type === 'extension_ui_request') {
      const method = String(frame.method ?? '')
      if (['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'].includes(method)) return
      const id = typeof frame.id === 'string' ? frame.id : undefined
      if (id) writeFrame({ type: 'extension_ui_response', id, cancelled: true })
      const error = new Error(`무인 실행에서 OMP UI 요청(${method || 'unknown'})을 승인할 수 없습니다`)
      options.onLog('error', error.message)
      failAll(error)
      try {
        writeFrame({ id: `abort-${++commandSeq}`, type: 'abort' })
      } catch {
        // 종료 경로에서 처리한다.
      }
      return
    }

    if (frame.type === 'host_tool_call' || frame.type === 'host_uri_request') {
      const id = typeof frame.id === 'string' ? frame.id : undefined
      if (id && frame.type === 'host_tool_call') {
        writeFrame({
          type: 'host_tool_result',
          id,
          isError: true,
          result: { content: [{ type: 'text', text: 'Palace OMP automation does not expose host tools.' }] }
        })
      } else if (id) {
        writeFrame({ type: 'host_uri_result', id, isError: true, error: 'Palace OMP automation does not expose host URI handlers.' })
      }
      return
    }
  }

  const acceptPhysicalFrame = (line: string): void => {
    if (!line.trim()) return
    if (Buffer.byteLength(line, 'utf8') > frameLimit) {
      throw new Error(`OMP RPC v1 프레임이 ${frameLimit}바이트 제한을 초과했습니다. 프로토콜 v2가 필요합니다`)
    }
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch (error) {
      throw new Error(`OMP RPC JSON 프레임을 해석할 수 없습니다: ${errorMessage(error)}`)
    }
    const frame = asRecord(value)
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
    const data = frame.data
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || !Number.isSafeInteger(byteLength) || typeof data !== 'string') {
      throw new Error('OMP RPC 청크 메타데이터가 올바르지 않습니다')
    }
    if (
      Number(count) <= 0 ||
      Number(count) > 65_536 ||
      Number(index) < 0 ||
      Number(index) >= Number(count) ||
      Number(byteLength) < 0 ||
      Number(byteLength) > reassemblyLimit
    ) {
      throw new Error('OMP RPC 청크 범위가 올바르지 않습니다')
    }
    if (!chunk) {
      if (Number(index) !== 0) throw new Error('OMP RPC 청크 시퀀스가 0번에서 시작하지 않았습니다')
      chunk = {
        id,
        count: Number(count),
        byteLength: Number(byteLength),
        parts: [],
        nextIndex: 0,
        receivedBytes: 0
      }
    }
    if (chunk.id !== id || chunk.count !== Number(count) || chunk.byteLength !== Number(byteLength) || chunk.nextIndex !== Number(index)) {
      throw new Error('OMP RPC 청크 시퀀스가 교차되거나 순서가 어긋났습니다')
    }
    let decoded: Buffer
    try {
      decoded = Buffer.from(data, 'base64')
      if (decoded.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')) throw new Error('invalid base64')
    } catch {
      throw new Error('OMP RPC 청크의 base64 데이터가 올바르지 않습니다')
    }
    chunk.parts.push(decoded)
    chunk.nextIndex += 1
    chunk.receivedBytes += decoded.byteLength
    if (chunk.receivedBytes > chunk.byteLength || chunk.receivedBytes > reassemblyLimit) {
      throw new Error('OMP RPC 청크 재조립 크기가 선언된 한도를 초과했습니다')
    }
    if (chunk.nextIndex === chunk.count) {
      const completed = Buffer.concat(chunk.parts)
      const expected = chunk.byteLength
      chunk = undefined
      if (completed.byteLength !== expected) throw new Error('OMP RPC 청크 재조립 길이가 일치하지 않습니다')
      let json: string
      try {
        json = new TextDecoder('utf-8', { fatal: true }).decode(completed)
      } catch {
        throw new Error('OMP RPC 청크가 올바른 UTF-8이 아닙니다')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(json) as unknown
      } catch (error) {
        throw new Error(`재조립한 OMP RPC 프레임을 해석할 수 없습니다: ${errorMessage(error)}`)
      }
      handleFrame(parsed)
    }
  }

  stdout.on('data', (data: Buffer) => {
    if (fatal) return
    try {
      stdoutBuffer += stdoutDecoder.decode(data, { stream: true })
      if (Buffer.byteLength(stdoutBuffer, 'utf8') > frameLimit * 2) throw new Error('OMP RPC가 종료되지 않은 과대 프레임을 보냈습니다')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) acceptPhysicalFrame(line)
    } catch (error) {
      failAll(error instanceof Error ? error : new Error(String(error)))
      terminateProcessGroup(child)
    }
  })

  child.on('error', (error) => {
    failAll(new Error(`OMP 프로세스를 시작할 수 없습니다: ${error.message}`))
  })

  child.on('close', (code) => {
    closed = true
    closeCode = code
    if (!fatal) {
      try {
        stdoutBuffer += stdoutDecoder.decode()
      } catch {
        failAll(new Error('OMP RPC stdout이 올바른 UTF-8이 아닙니다'))
      }
    }
    flushAssistant()
    if (!fatal && (stdoutBuffer.trim() || chunk)) {
      failAll(new Error(chunk ? 'OMP RPC가 청크 전송 중 종료되었습니다' : 'OMP RPC가 완전하지 않은 JSON 프레임을 남기고 종료되었습니다'))
    } else if (!fatal && prompt && !prompt.settled) {
      failAll(new Error(`OMP RPC가 에이전트 완료 전에 종료되었습니다 (code ${code ?? 'signal'})${stderr ? `: ${stderr.trim()}` : ''}`))
    } else if (!fatal && pending.size > 0) {
      failAll(new Error(`OMP RPC가 명령 응답 전에 종료되었습니다 (code ${code ?? 'signal'})`))
    } else if (!fatal && !ready) {
      failAll(new Error(`OMP RPC가 ready 전에 종료되었습니다 (code ${code ?? 'signal'})${stderr ? `: ${stderr.trim()}` : ''}`))
    }
    terminateProcessGroup(child)
    resolveClosed()
  })

  const abortHandler = (): void => {
    const error = new Error('OMP 실행이 취소되었습니다')
    failAll(error)
    try {
      writeFrame({ id: `abort-${++commandSeq}`, type: 'abort' })
    } catch {
      // 프로세스 그룹 종료가 최종 취소 수단이다.
    }
    terminateProcessGroup(child)
  }
  options.signal.addEventListener('abort', abortHandler, { once: true })

  const timeout = setTimeout(() => {
    const error = new Error('OMP 실행 제한 시간이 만료되었습니다')
    failAll(error)
    try {
      writeFrame({ id: `abort-${++commandSeq}`, type: 'abort' })
    } catch {
      // 프로세스 그룹 종료가 최종 타임아웃 수단이다.
    }
    terminateProcessGroup(child)
  }, options.timeoutMs)
  timeout.unref()

  const sendCommand = (type: string, fields: Record<string, unknown> = {}): Promise<RpcResponse> => {
    const id = `palace-${++commandSeq}`
    return new Promise<RpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        writeFrame({ id, type, ...fields })
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  try {
    const readyFrame = await readyPromise
    const supported = Array.isArray(readyFrame.supportedProtocolVersions) ? readyFrame.supportedProtocolVersions : []
    if (supported.includes(2)) {
      try {
        await sendCommand('negotiate_protocol', { protocolVersion: 2 })
        negotiatedV2 = true
      } catch (error) {
        options.onLog('system', `OMP RPC v2 협상 실패, v1 제한 모드로 계속합니다: ${redactLogText(errorMessage(error))}`)
      }
    } else {
      options.onLog('system', 'OMP RPC v1 서버: 1 MiB 초과 프레임은 명시적 오류로 처리됩니다')
    }

    const promptId = `palace-${++commandSeq}`
    await new Promise<RpcResponse>((resolve, reject) => {
      prompt = { id: promptId, acknowledged: false, terminal: false, settled: false, resolve, reject }
      try {
        writeFrame({ id: promptId, type: 'prompt', message: options.prompt })
      } catch (error) {
        prompt.settled = true
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    if (fatal) throw fatal

    const [stateResponse, summaryResponse] = await Promise.all([sendCommand('get_state'), sendCommand('get_last_assistant_text')])
    const state = asRecord(stateResponse.data)
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : undefined
    const summary = extractSummary(summaryResponse.data).trim()
    if (summary) options.onLog('system', `최종 요약:\n${redactLogText(summary)}`)

    stdin.end()
    const shutdownTimeout = setTimeout(() => terminateProcessGroup(child), SHUTDOWN_GRACE_MS)
    shutdownTimeout.unref()
    await closedPromise
    clearTimeout(shutdownTimeout)
    if (fatal) throw fatal
    if (closeCode !== 0) throw new Error(`OMP RPC가 code ${closeCode ?? 'signal'}로 종료되었습니다${stderr ? `: ${stderr.trim()}` : ''}`)
    return { sessionFile, summary }
  } finally {
    clearTimeout(timeout)
    options.signal.removeEventListener('abort', abortHandler)
    if (!closed) {
      try {
        stdin.end()
      } catch {
        // 종료 중인 stdin이다.
      }
      terminateProcessGroup(child)
    }
  }
}
