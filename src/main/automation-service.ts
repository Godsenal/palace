import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer, get as httpGet, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AUTOMATION_PORT } from '../shared/automation'
import { AutomationService, validateLoopDefinition, validateMachineSettings, validateOmpProfile } from './automation/service'
import { AutomationStore, assertSafeId, type ServiceDescriptor } from './automation/store'
import packageJson from '../../package.json'
import { Workbench } from './workbench'

const MAX_BODY_BYTES = 1024 * 1024
const SERVICE_NAME = 'palace-omp'

interface ApiRequest {
  method: string
  args: unknown[]
}

interface HealthResponse {
  name: string
  pid: number
  version: string
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function parseApiRequest(value: unknown): ApiRequest {
  const row = objectRecord(value)
  if (!row || typeof row.method !== 'string' || !Array.isArray(row.args)) throw new Error('API 요청 형식은 {method,args:[]}여야 합니다')
  return { method: row.method, args: row.args }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value))
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  response.end(body)
}

function safeTokenEqual(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return false
  const expectedDigest = createHash('sha256').update(expected).digest()
  const actualDigest = createHash('sha256').update(actual).digest()
  return timingSafeEqual(expectedDigest, actualDigest)
}
function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return undefined
  return authorization.slice(7)
}

function originAllowed(request: IncomingMessage, port: number): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && parsed.port === String(port) && parsed.protocol === 'http:'
  } catch {
    return false
  }
}

async function readJsonBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const contentType = request.headers['content-type'] ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) throw new Error('Content-Type은 application/json이어야 합니다')
  const announced = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(announced) && announced > limit) throw new Error(`요청 본문은 ${limit / 1024 / 1024}MB를 넘을 수 없습니다`)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > limit) throw new Error(`요청 본문은 ${limit / 1024 / 1024}MB를 넘을 수 없습니다`)
    chunks.push(bytes)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  if (!body) return {}
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new Error('요청 본문이 유효한 JSON이 아닙니다')
  }
}

function requireArgumentCount(method: string, args: unknown[], minimum: number, maximum = minimum): void {
  if (args.length < minimum || args.length > maximum) throw new Error(`${method} 인자 수가 올바르지 않습니다`)
}

async function dispatchApi(service: AutomationService, request: ApiRequest): Promise<unknown> {
  const { method, args } = request
  switch (method) {
    case 'snapshot':
      requireArgumentCount(method, args, 0)
      return service.snapshot()
    case 'saveLoop':
      requireArgumentCount(method, args, 1)
      return service.saveLoop(validateLoopDefinition(args[0]))
    case 'deleteLoop':
      requireArgumentCount(method, args, 1)
      if (typeof args[0] !== 'string') throw new Error('루프 ID가 필요합니다')
      return service.deleteLoop(args[0])
    case 'approveLoop':
      requireArgumentCount(method, args, 1)
      if (typeof args[0] !== 'string') throw new Error('루프 ID가 필요합니다')
      return service.approveLoop(args[0])
    case 'runLoop':
      requireArgumentCount(method, args, 1)
      if (typeof args[0] !== 'string') throw new Error('루프 ID가 필요합니다')
      return service.runLoop(args[0])
    case 'cancelRun':
      requireArgumentCount(method, args, 1)
      if (typeof args[0] !== 'string') throw new Error('실행 ID가 필요합니다')
      return service.cancelRun(args[0])
    case 'runDetail': {
      requireArgumentCount(method, args, 1, 2)
      const after = args[1]
      if (typeof args[0] !== 'string' || (after !== undefined && (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0))) throw new Error('실행 ID 또는 로그 커서가 올바르지 않습니다')
      return service.runDetail(args[0], after)
    }
    case 'saveSettings':
      requireArgumentCount(method, args, 1)
      return service.saveSettings(validateMachineSettings(args[0]))
    case 'saveOmp':
      requireArgumentCount(method, args, 1)
      return service.saveOmp(validateOmpProfile(args[0]))
    case 'importOmp':
      requireArgumentCount(method, args, 0)
      return service.importOmp()
    case 'sync':
      requireArgumentCount(method, args, 1)
      if (args[0] !== 'push' && args[0] !== 'pull') throw new Error('동기화 방향은 push 또는 pull이어야 합니다')
      return service.sync(args[0])
    case 'webhook':
      requireArgumentCount(method, args, 1)
      if (typeof args[0] !== 'string') throw new Error('루프 ID가 필요합니다')
      return service.webhook(args[0])
    case 'service':
      throw new Error('서비스 설치 관리는 데스크톱 앱에서만 사용할 수 있습니다')
    default:
      throw new Error(`알 수 없는 API 메서드입니다: ${method}`)
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, service: AutomationService, descriptor: ServiceDescriptor, version: string, workbench: Workbench): Promise<void> {
  if (!originAllowed(request, descriptor.port)) {
    sendJson(response, 403, { error: '외부 Origin 요청은 허용되지 않습니다' })
    return
  }

  const url = new URL(request.url ?? '/', `http://127.0.0.1:${descriptor.port}`)
  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { name: SERVICE_NAME, pid: process.pid, version })
    return
  }

  if (request.method === 'POST' && url.pathname === '/api') {
    if (!safeTokenEqual(descriptor.token, bearerToken(request))) {
      sendJson(response, 401, { error: '인증 토큰이 올바르지 않습니다' })
      return
    }
    try {
      // 검증된 프로필(최대 5MB)과 JSON RPC 봉투를 수용한다. 웹훅은 1MB 유지.
      const rpc = parseApiRequest(await readJsonBody(request, 6 * 1024 * 1024))
      const result = await workbench.dispatch(rpc.method, rpc.args)
      sendJson(response, 200, { result: result === undefined ? null : result })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (request.method === 'POST' && url.pathname.startsWith('/webhooks/')) {
    const encodedId = url.pathname.slice('/webhooks/'.length)
    let id: string
    try {
      id = decodeURIComponent(encodedId)
      assertSafeId(id, '루프 ID')
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    if (!safeTokenEqual(service.webhookToken(id), bearerToken(request))) {
      sendJson(response, 401, { error: '웹훅 토큰이 올바르지 않습니다' })
      return
    }
    const header = request.headers['x-delivery-id']
    const deliveryId = Array.isArray(header) ? undefined : header
    if (!deliveryId || !/^[\x21-\x7e]{1,200}$/.test(deliveryId)) {
      sendJson(response, 400, { error: '유효한 X-Delivery-ID 헤더가 필요합니다' })
      return
    }
    try {
      const payload = await readJsonBody(request)
      const run = await service.enqueueWebhook(id, deliveryId, payload)
      sendJson(response, run ? 202 : 200, { result: run ?? { duplicate: true } })
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  sendJson(response, 404, { error: '경로를 찾을 수 없습니다' })
}

export async function probeServiceIdentity(port: number): Promise<HealthResponse | undefined> {
  return new Promise((resolve) => {
    const request = httpGet({ hostname: '127.0.0.1', port, path: '/health', timeout: 1_500 }, (response) => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength
        if (size <= 16_384) chunks.push(chunk)
      })
      response.on('end', () => {
        if (response.statusCode !== 200 || size > 16_384) return resolve(undefined)
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          const row = objectRecord(value)
          if (row?.name !== SERVICE_NAME || typeof row.pid !== 'number' || typeof row.version !== 'string') return resolve(undefined)
          resolve({ name: SERVICE_NAME, pid: row.pid, version: row.version })
        } catch {
          resolve(undefined)
        }
      })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve(undefined))
  })
}

export interface RunningAutomationHttpService {
  server: Server
  service: AutomationService
  descriptor: ServiceDescriptor
  close(): Promise<void>
}

export async function startAutomationHttpService(options?: { root?: string; port?: number; version?: string }): Promise<RunningAutomationHttpService> {
  const root = options?.root ?? process.env.PALACE_OMP_HOME ?? join(homedir(), '.palace-omp')
  const configuredPort = options?.port ?? Number(process.env.PALACE_OMP_PORT ?? AUTOMATION_PORT)
  if (!Number.isSafeInteger(configuredPort) || configuredPort < 1 || configuredPort > 65_535) throw new Error('PALACE_OMP_PORT가 올바르지 않습니다')
  const port = configuredPort
  const version = options?.version ?? process.env.PALACE_OMP_VERSION ?? packageJson.version
  const store = new AutomationStore(root)
  const previousDescriptor = store.readDescriptor()
  try {
    store.acquireLock()
  } catch (error) {
    const identity = previousDescriptor ? await probeServiceIdentity(previousDescriptor.port) : undefined
    if (identity && previousDescriptor && identity.pid === previousDescriptor.pid) {
      throw new Error(`Palace OMP 서비스가 이미 포트 ${previousDescriptor.port}에서 실행 중입니다 (PID ${identity.pid})`)
    }
    throw error
  }

  let service: AutomationService | undefined
  let server: Server | undefined
  let workbench: Workbench | undefined
  try {
    const core = await AutomationService.create({ root, port, version })
    service = core
    const workspace = new Workbench(core, root, (method, args) => dispatchApi(core, { method, args }))
    workbench = workspace
    await workspace.initialize()
    const descriptor: ServiceDescriptor = { port, token: randomBytes(32).toString('base64url'), pid: process.pid }
    server = createServer((request, response) => {
      void handleRequest(request, response, core, descriptor, version, workspace).catch((error) => {
        if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        else response.destroy()
      })
    })
    server.requestTimeout = 30_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 5_000
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(port, '127.0.0.1', () => {
        server?.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1' || address.port !== port) throw new Error('서비스가 로컬 전용 주소에 바인딩되지 않았습니다')
    store.writeDescriptor(descriptor)
    core.start()

    let closed = false
    return {
      server,
      service: core,
      descriptor,
      close: async () => {
        if (closed) return
        closed = true
        await new Promise<void>((resolve) => {
          server?.close(() => resolve())
          server?.closeAllConnections()
        })
        await core.shutdown()
        await workspace.shutdown()
        store.removeDescriptor(process.pid)
        store.releaseLock()
      }
    }
  } catch (error) {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    }
    await service?.shutdown()
    await workbench?.shutdown()
    const identity = await probeServiceIdentity(port)
    store.removeDescriptor(process.pid)
    store.releaseLock()
    const errorCode = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
    if (errorCode === 'EADDRINUSE') {
      if (identity) throw new Error(`Palace OMP 서비스가 이미 포트 ${port}에서 실행 중입니다 (PID ${identity.pid})`)
      throw new Error(`포트 ${port}를 다른 프로세스가 사용 중입니다`)
    }
    throw error
  }
}

async function main(): Promise<void> {
  const running = await startAutomationHttpService()
  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    await running.close()
    process.exitCode = 0
  }
  process.once('SIGINT', () => void close())
  process.once('SIGTERM', () => void close())
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
