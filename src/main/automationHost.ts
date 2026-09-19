import { app, dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { AutomationAPI, AutomationSnapshot, ServiceStatus } from '../shared/automation'
import { AUTOMATION_PORT } from '../shared/automation'
import { WORKBENCH_METHODS } from '../shared/workbench'
import { setTimeout as delay } from 'node:timers/promises'
import { primeShellPath, runCapture } from './exec'

const root = process.env.PALACE_OMP_HOME || join(homedir(), '.palace-omp')
const port = Number(process.env.PALACE_OMP_PORT || AUTOMATION_PORT)
const descriptorPath = join(root, 'service.json')
const entry = join(__dirname, 'automation-service.js')
const label = `com.godsenal.palace-omp.${createHash('sha256').update(root).digest('hex').slice(0, 10)}`
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`
const xml = (text: string): string => text.replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]!)
interface Descriptor { port: number; token: string; pid: number }
let starting: Promise<Descriptor> | undefined

function descriptor(): Descriptor | undefined {
  try {
    const value = JSON.parse(readFileSync(descriptorPath, 'utf8')) as Descriptor
    if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 || value.port !== port ||
      !Number.isInteger(value.pid) || value.pid < 2 || typeof value.token !== 'string' || value.token.length < 32) return undefined
    return value
  } catch { return undefined }
}

async function alive(): Promise<Descriptor | undefined> {
  const d = descriptor()
  if (!d) return undefined
  try {
    const response = await fetch(`http://127.0.0.1:${d.port}/health`, { signal: AbortSignal.timeout(1000) })
    const health = await response.json() as { name?: string; pid?: number }
    if (response.ok && health.name === 'palace-omp' && health.pid === d.pid) return d
  } catch { /* 서비스가 시작 중이거나 중지됨 */ }
  return undefined
}

async function ensureService(): Promise<Descriptor> {
  const current = await alive()
  if (current) return current
  if (starting) return starting
  starting = (async () => {
    if (!isAbsolute(root) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('서비스 경로/포트 설정이 올바르지 않습니다.')
    if (!existsSync(entry)) throw new Error('자동화 서비스 번들이 없습니다. npm run build 후 다시 실행하세요.')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    const engineSource = app.isPackaged ? join(process.resourcesPath, 'engines/loops') : join(__dirname, '../../engines/loops')
    const command = `nohup env ELECTRON_RUN_AS_NODE=1 PALACE_OMP_HOME=${quote(root)} PALACE_OMP_PORT=${port} PALACE_OMP_ENGINE_SOURCE=${quote(engineSource)} ${quote(process.execPath)} ${quote(entry)} >${quote(join(root, 'service.log'))} 2>&1 </dev/null &`
    const result = await runCapture(command, root, undefined, 15_000)
    if (result.code !== 0) throw new Error(`서비스 시작 실패: ${result.stderr || result.stdout}`)
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const ready = await alive()
      if (ready) return ready
      await delay(150)
    }
    let detail = ''
    try { detail = readFileSync(join(root, 'service.log'), 'utf8').slice(-2000) } catch { /* 파일 생성 전 실패 */ }
    throw new Error(`서비스가 준비되지 않았습니다. 포트 ${port}와 ${join(root, 'service.log')}를 확인하세요.\n${detail}`)
  })().finally(() => { starting = undefined })
  return starting
}

async function invoke(method: string, args: unknown[]): Promise<unknown> {
  const d = await ensureService()
  // 네트워크 변경 요청은 실패 시 재전송하지 않는다(실행 중복 방지).
  const response = await fetch(`http://127.0.0.1:${d.port}/api`, {
    method: 'POST', headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(method === 'setup.install' ? 660_000 : method === 'sync' || method.startsWith('skills.') ? 180_000 : 60_000)
  })
  const body = await response.json() as { result?: unknown; error?: string }
  if (!response.ok) throw new Error(body.error || `서비스 오류 (${response.status})`)
  return body.result
}

async function serviceStatus(): Promise<ServiceStatus> {
  const running = !!(await alive())
  const installed = existsSync(plistPath)
  return { running, installed, message: installed ? '로그인 후 launchd가 서비스를 실행합니다.' : '앱을 닫아도 서비스는 유지됩니다. 재부팅 후 자동 실행은 아직 등록되지 않았습니다.' }
}

async function stopIdleService(): Promise<void> {
  const d = await alive()
  if (!d) return
  const state = await invoke('snapshot', []) as AutomationSnapshot
  if (state.runs.some((run) => ['queued', 'running', 'checking'].includes(run.status))) throw new Error('진행·대기 중인 작업을 마친 뒤 서비스 등록을 변경하세요.')
  process.kill(d.pid, 'SIGTERM')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (!(await alive())) return
    await delay(150)
  }
  throw new Error('서비스가 종료되지 않았습니다. 등록을 변경하지 않았습니다.')
}

async function configureService(action: 'status' | 'install' | 'uninstall'): Promise<ServiceStatus> {
  if (action === 'status') return serviceStatus()
  if (process.platform !== 'darwin') throw new Error('로그인 서비스 등록은 macOS에서 지원합니다. 다른 환경에서는 automation-service.js를 프로세스 관리자로 실행하세요.')
  const domain = `gui/${process.getuid!()}`
  if (action === 'uninstall') {
    if (await alive()) {
      const state = await invoke('snapshot', []) as AutomationSnapshot
      if (state.runs.some((run) => ['queued', 'running', 'checking'].includes(run.status))) throw new Error('진행·대기 중인 작업을 마친 뒤 서비스 등록을 변경하세요.')
    }
    if (existsSync(plistPath)) {
      const result = await runCapture(`launchctl bootout ${quote(`${domain}/${label}`)}`, root)
      if (result.code !== 0 && !/could not find|no such process|not found/i.test(result.stderr)) throw new Error(result.stderr || '서비스 등록 해제 실패')
      unlinkSync(plistPath)
    }
    return serviceStatus()
  }
  if (action !== 'install') throw new Error('알 수 없는 서비스 명령')
  if (!app.isPackaged) throw new Error('재부팅 자동 실행은 설치된 Palace OMP 앱에서 등록하세요. 개발 빌드 경로는 업데이트 때 사라질 수 있습니다.')
  if (existsSync(plistPath)) return serviceStatus()
  await ensureService()
  await stopIdleService()
  const path = await primeShellPath()
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
  const env = { ELECTRON_RUN_AS_NODE: '1', PALACE_OMP_HOME: root, PALACE_OMP_PORT: String(port), PALACE_OMP_ENGINE_SOURCE: join(process.resourcesPath, 'engines/loops'), PATH: path || process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin' }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string></array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer><key>StandardOutPath</key><string>${xml(join(root, 'service.log'))}</string><key>StandardErrorPath</key><string>${xml(join(root, 'service.log'))}</string></dict></plist>\n`
  writeFileSync(plistPath, plist, { mode: 0o600 })
  const result = await runCapture(`launchctl bootstrap ${quote(domain)} ${quote(plistPath)}`, root)
  if (result.code !== 0) {
    unlinkSync(plistPath)
    throw new Error(`서비스 등록 실패: ${result.stderr || result.stdout}`)
  }
  return serviceStatus()
}

export function registerAutomationIpc(getWindow: () => BrowserWindow | null): void {
  const allowed: Partial<Record<keyof AutomationAPI, true>> = {
    snapshot: true, saveLoop: true, deleteLoop: true, approveLoop: true, runLoop: true,
    cancelRun: true, runDetail: true, saveSettings: true, saveOmp: true, importOmp: true,
    sync: true, webhook: true
  }
  const checkSender = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== getWindow()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('자동화 API는 Palace 기본 창에서만 사용할 수 있습니다.')
  }
  ipcMain.handle('palace:automation', async (event, method: keyof AutomationAPI, args: unknown[]) => {
    checkSender(event)
    if (!Object.hasOwn(allowed, method) || !Array.isArray(args)) throw new Error('잘못된 자동화 요청')
    return invoke(method, args)
  })
  ipcMain.handle('palace:workbench', async (event, method: string, args: unknown[]) => {
    checkSender(event)
    const [namespace, name, extra] = typeof method === 'string' ? method.split('.') : []
    if (extra || !Object.hasOwn(WORKBENCH_METHODS, namespace) || !WORKBENCH_METHODS[namespace].includes(name) || !Array.isArray(args)) throw new Error('잘못된 워크벤치 요청')
    if (method === 'setup.chooseProject') {
      const window = getWindow()
      if (!window) throw new Error('프로젝트 선택 창을 열 수 없습니다')
      const selected = await dialog.showOpenDialog(window, { title: '프로젝트 폴더 연결', properties: ['openDirectory'] })
      if (selected.canceled || !selected.filePaths[0]) return null
      const path = selected.filePaths[0]
      const snapshot = await invoke('snapshot', []) as AutomationSnapshot
      const existing = Object.entries(snapshot.settings.projectPaths).find(([, value]) => value === path)?.[0]
      const base = basename(path).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 48) || 'project'
      let name = existing || base
      for (let index = 2; !existing && snapshot.settings.projectPaths[name]; index++) name = `${base}-${index}`
      await invoke('saveSettings', [{ ...snapshot.settings, projectPaths: { ...snapshot.settings.projectPaths, [name]: path } }])
      return { name, path }
    }
    return invoke(method, args)
  })
  ipcMain.handle('palace:automationService', async (event, action) => {
    checkSender(event)
    return configureService(action)
  })
}
