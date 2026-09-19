import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import QRCode from 'qrcode'
import { AutomationService, validateLoopDefinition, validateMachineSettings } from './automation/service'
import { AutomationStore, writePrivateAtomic } from './automation/store'
import { CmuxBridge } from './companion/cmux'
import { SkillsService } from './workbench/skills'
import type { SkillTarget } from '../shared/workbench'
import type { CmuxKey, CompanionSnapshot } from '../shared/companion'
import packageJson from '../../package.json'

const DEFAULT_PORT = 48732
const MAX_BODY = 1024 * 1024
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon'
}
const KEYS = new Set<CmuxKey>(['Enter', 'Escape', 'Ctrl+C', 'Up', 'Down', 'Tab'])
const SKILL_MUTATIONS = new Set(['skills.install', 'skills.update', 'skills.remove'])
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)
const rootDirectory = (): string => resolve(process.env.CMUX_OMP_HOME || join(homedir(), '.cmux-omp'))

function publicOrigin(value = process.env.CMUX_OMP_PUBLIC_URL || ''): string | undefined {
  if (!value) return undefined
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('CMUX_OMP_PUBLIC_URL은 경로·인증 정보 없는 HTTPS origin이어야 합니다')
  }
  return url.origin
}

function readToken(root: string): string {
  const token: unknown = JSON.parse(readFileSync(join(root, 'pairing-token.json'), 'utf8'))
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('페어링 토큰 파일이 올바르지 않습니다')
  return token
}
function newToken(root: string): string {
  const token = randomBytes(32).toString('base64url')
  writePrivateAtomic(join(root, 'pairing-token.json'), token)
  return token
}
function authenticated(request: IncomingMessage, root: string): boolean {
  const supplied = request.headers.authorization
  if (!supplied?.startsWith('Bearer ') || supplied.length > 100) return false
  const hash = (value: string): Buffer => createHash('sha256').update(value).digest()
  return timingSafeEqual(hash(readToken(root)), hash(supplied.slice(7)))
}
function securityHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}
async function body(request: IncomingMessage): Promise<{ method: string; args: unknown[] }> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('application/json 요청이 필요합니다')
  if (Number(request.headers['content-length'] || 0) > MAX_BODY) throw new Error('요청이 너무 큽니다')
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    length += buffer.length
    if (length > MAX_BODY) throw new Error('요청이 너무 큽니다')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || !('method' in value) || typeof value.method !== 'string' || !('args' in value) || !Array.isArray(value.args)) {
    throw new Error('요청 형식은 {method,args:[]}입니다')
  }
  return { method: value.method, args: value.args }
}
function arity(args: unknown[], min: number, max = min): void {
  if (args.length < min || args.length > max) throw new Error('인자 수가 올바르지 않습니다')
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 100_000) throw new Error('문자열 인자가 올바르지 않습니다')
  return value
}

function skillTarget(value: unknown): SkillTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('스킬 설치 범위를 선택하세요')
  const target = value as Record<string, unknown>
  if (target.scope === 'global' && Object.keys(target).length === 1) return { scope: 'global' }
  if (target.scope === 'project' && Object.keys(target).length === 2) return { scope: 'project', project: text(target.project) }
  throw new Error('스킬 설치 범위는 프로젝트 또는 글로벌이어야 합니다')
}

async function dispatch(core: AutomationService, cmux: CmuxBridge, skills: SkillsService, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'snapshot': {
      arity(args, 0)
      const [automation, terminals] = await Promise.all([core.snapshot(), cmux.snapshot()])
      return { automation, cmux: terminals } satisfies CompanionSnapshot
    }
    case 'saveLoop': arity(args, 1); return core.saveLoop(validateLoopDefinition(args[0]))
    case 'approveLoop': arity(args, 1); return core.approveLoop(text(args[0]))
    case 'deleteLoop': arity(args, 1); return core.deleteLoop(text(args[0]))
    case 'runLoop': arity(args, 1); return core.runLoop(text(args[0]))
    case 'cancelRun': arity(args, 1); return core.cancelRun(text(args[0]))
    case 'runDetail': {
      arity(args, 1, 2)
      if (args[1] !== undefined && (typeof args[1] !== 'number' || !Number.isSafeInteger(args[1]) || args[1] < 0)) throw new Error('로그 커서가 올바르지 않습니다')
      return core.runDetail(text(args[0]), args[1] as number | undefined)
    }
    case 'saveSettings': arity(args, 1); return core.saveSettings(validateMachineSettings(args[0]))
    case 'importOmp': arity(args, 0); return core.importOmp()
    case 'skills.locations': arity(args, 0); return skills.locations()
    case 'skills.search': arity(args, 1); return skills.search(text(args[0]))
    case 'skills.preview': arity(args, 1, 2); return skills.preview(text(args[0]), args[1] === undefined ? undefined : text(args[1]))
    case 'skills.list': arity(args, 1); return skills.list(skillTarget(args[0]))
    case 'skills.install': arity(args, 4); return skills.install(skillTarget(args[0]), text(args[1]), text(args[2]), text(args[3]))
    case 'skills.update': arity(args, 3); return skills.update(skillTarget(args[0]), text(args[1]), text(args[2]))
    case 'skills.remove': arity(args, 2); return skills.remove(skillTarget(args[0]), text(args[1]))
    case 'cmux.read': arity(args, 2); return cmux.read(text(args[0]), text(args[1]))
    case 'cmux.send': arity(args, 3); return cmux.send(text(args[0]), text(args[1]), text(args[2]))
    case 'cmux.key': {
      arity(args, 3)
      const key = text(args[2]) as CmuxKey
      if (!KEYS.has(key)) throw new Error('허용되지 않은 키입니다')
      return cmux.key(text(args[0]), text(args[1]), key)
    }
    case 'cmux.openRun': {
      arity(args, 1)
      const { run } = await core.runDetail(text(args[0]))
      return cmux.openRun(run, core.getSettings().ompCommand)
    }
    default: throw new Error('허용되지 않은 메서드입니다')
  }
}

export interface CompanionOptions { root?: string; port?: number; publicUrl?: string; assets?: string }
export async function startCompanion(options: CompanionOptions = {}) {
  const root = resolve(options.root || rootDirectory())
  const port = options.port ?? Number(process.env.CMUX_OMP_PORT || DEFAULT_PORT)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('CMUX_OMP_PORT가 올바르지 않습니다')
  const remote = publicOrigin(options.publicUrl)
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(remote ? [remote] : [])])
  const hosts = new Set([...origins].map((origin) => new URL(origin).host))
  const assets = await realpath(options.assets || resolve(__dirname, '../companion'))
  if (!existsSync(join(assets, 'index.html'))) throw new Error('먼저 npm run companion:build를 실행하세요')
  const store = new AutomationStore(root)
  store.acquireLock()
  let core: AutomationService | undefined
  let skills: SkillsService
  let skillOperation: Promise<unknown> = Promise.resolve()
  const cmux = new CmuxBridge()
  const server = createServer((request, response) => {
    securityHeaders(response)
    void (async () => {
      if (!hosts.has(request.headers.host || '') || (request.headers.origin && !origins.has(request.headers.origin))) {
        json(response, 403, { error: '허용되지 않은 Host 또는 Origin입니다' }); return
      }
      const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { name: 'cmux-omp-companion', version: packageJson.version }); return
      }
      if (url.pathname === '/api') {
        if (request.method !== 'POST') { json(response, 405, { error: 'POST 요청이 필요합니다' }); return }
        if (!authenticated(request, root)) { json(response, 401, { error: '연결 토큰을 확인하고 다시 페어링하세요' }); return }
        try {
          const rpc = await body(request)
          const invoke = (): Promise<unknown> => dispatch(core!, cmux, skills, rpc.method, rpc.args)
          let result: unknown
          if (SKILL_MUTATIONS.has(rpc.method)) {
            const operation = skillOperation.then(invoke)
            skillOperation = operation.then(() => undefined, () => undefined)
            result = await operation
          } else result = await invoke()
          json(response, 200, { result: result ?? null })
        } catch (error) { json(response, 400, { error: message(error) }) }
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') { json(response, 405, { error: '허용되지 않은 요청입니다' }); return }
      let path: string
      try { path = await realpath(resolve(assets, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`)) }
      catch { json(response, 404, { error: '파일을 찾을 수 없습니다' }); return }
      const inside = relative(assets, path)
      const type = MIME[extname(path)]
      if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !type || !(await stat(path)).isFile()) {
        json(response, 404, { error: '파일을 찾을 수 없습니다' }); return
      }
      const content = await readFile(path)
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length })
      response.end(request.method === 'HEAD' ? undefined : content)
    })().catch((error) => {
      if (!response.headersSent) json(response, 500, { error: message(error) })
      else response.destroy()
    })
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  try {
    const token = existsSync(join(root, 'pairing-token.json')) ? readToken(root) : newToken(root)
    core = await AutomationService.create({ root, port, version: packageJson.version })
    skills = new SkillsService({ root, getSettings: () => core!.getSettings() })
    await new Promise<void>((accept, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); accept() })
    })
    store.writeDescriptor({ port, token, pid: process.pid })
    writePrivateAtomic(join(root, 'connection.json'), { localUrl: `http://127.0.0.1:${port}`, publicUrl: remote || null })
    core.start()
  } catch (error) {
    server.close()
    await core?.shutdown()
    store.removeDescriptor(process.pid)
    store.releaseLock()
    throw error
  }
  let closed = false
  return {
    server, core, root, port,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await new Promise<void>((accept) => { server.close(() => accept()); server.closeAllConnections() })
      await skillOperation
      await core!.shutdown()
      store.removeDescriptor(process.pid)
      store.releaseLock()
    }
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] || 'start'
  const root = rootDirectory()
  if (command === 'rotate-token') {
    if (!existsSync(join(root, 'pairing-token.json'))) throw new Error('먼저 companion을 시작하세요')
    newToken(root)
    console.log('이전 연결 토큰을 폐기했습니다. companion:pair로 새 기기를 연결하세요.')
    return
  }
  if (command === 'pair') {
    const token = readToken(root)
    const connection = JSON.parse(readFileSync(join(root, 'connection.json'), 'utf8')) as { localUrl: string; publicUrl: string | null }
    const origin = publicOrigin() || connection.publicUrl || connection.localUrl
    const url = `${origin}/#token=${token}`
    console.log('이 링크는 Mac 제어 권한입니다. 공유하지 마세요.\n' + url)
    console.log(await QRCode.toString(url, { type: 'terminal', small: true }))
    if (!connection.publicUrl && !process.env.CMUX_OMP_PUBLIC_URL) console.log('현재 로컬 전용입니다. 휴대폰은 Tailscale HTTPS 연결 설정이 필요합니다. README의 companion 절을 참고하세요.')
    return
  }
  if (command !== 'start') throw new Error('사용법: companion-service.js [start|pair|rotate-token]')
  const running = await startCompanion()
  console.log(`cmux · OMP companion ready: http://127.0.0.1:${running.port}`)
  console.log('연결 QR: npm run companion:pair — Mac이 깨어 있는 동안 예약을 실행합니다.')
  let stopping = false
  const stop = (): void => {
    if (stopping) return
    stopping = true
    void running.close().catch((error) => { console.error(message(error)); process.exitCode = 1 })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
if (require.main === module) void main().catch((error) => { console.error(message(error)); process.exitCode = 1 })
