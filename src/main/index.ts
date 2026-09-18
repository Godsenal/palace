import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import electronUpdater from 'electron-updater'
import { AppManager } from './appManager'
import { registerIpc, broadcast } from './ipc'
import { loadSettings, ensureDirs } from './paths'
import { syncLoginItems, ensureCmuxRunning } from './autostart'
import { primeShellPath } from './exec'
import { watchPowerSource } from './keepAwake'
import type { LogLine, ProgressEvent } from '../shared/types'
import { registerAutomationIpc } from './automationHost'

const { autoUpdater } = electronUpdater
const updateFeed = process.env.PALACE_OMP_UPDATE_URL
if (updateFeed) autoUpdater.setFeedURL({ provider: 'generic', url: updateFeed })

let mainWindow: BrowserWindow | null = null
let appManager: AppManager | null = null

// ---- 상태 브로드캐스트(가벼운 디바운스) ----
let pushTimer: NodeJS.Timeout | null = null
function schedulePush(): void {
  if (pushTimer) return
  pushTimer = setTimeout(async () => {
    pushTimer = null
    if (!appManager) return
    try {
      const apps = await appManager.listApps()
      broadcast('palace:state', apps)
    } catch {
      /* noop */
    }
  }, 120)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f1115',
    title: 'Palace OMP',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true // 앱 대시보드 임베드용
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 외부 링크는 기본 브라우저로
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ensureDirs()
  app.setName('Palace OMP')

  // 첫 스텝이 PATH 를 기다리지 않게 미리 데워둔다(대화형 셸 1회 = 수백 ms~수 초).
  void primeShellPath(loadSettings().shell)

  appManager = new AppManager({
    getSettings: () => loadSettings(),
    emitLog: (l: LogLine) => broadcast('palace:log', l),
    emitProgress: (p: ProgressEvent) => broadcast('palace:progress', p),
    emitState: () => schedulePush()
  })

  registerIpc(appManager)
  registerAutomationIpc(() => mainWindow)

  // 허브 자체 업데이트 체크(패키징 후 GitHub Releases 기준). 개발중엔 조용히 실패.
  ipcMain.handle('palace:checkHubUpdate', async () => {
    if (!updateFeed) return { available: false, error: 'Palace OMP 전용 업데이트 피드가 연결되지 않았습니다.' }
    try {
      autoUpdater.autoDownload = false
      const r = await autoUpdater.checkForUpdates()
      const v = r?.updateInfo?.version
      return { available: !!v && v !== app.getVersion(), version: v }
    } catch (e) {
      return { available: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 진행률/완료/오류를 renderer 로 스트리밍(설정 모달의 진행 표시용).
  autoUpdater.on('download-progress', (p) => broadcast('palace:hubProgress', { percent: p.percent }))
  autoUpdater.on('update-downloaded', (info) =>
    broadcast('palace:hubProgress', { percent: 100, downloaded: true, version: info.version })
  )
  autoUpdater.on('error', (e) =>
    broadcast('palace:hubProgress', { error: e instanceof Error ? e.message : String(e) })
  )

  // "지금 업데이트": 새 버전을 다운로드(완료 시 resolve). 없으면 message 로 알림.
  ipcMain.handle('palace:downloadHubUpdate', async () => {
    if (!updateFeed) return { ok: false, error: 'Palace OMP 전용 업데이트 피드를 먼저 연결하세요.' }
    try {
      autoUpdater.autoDownload = false
      const r = await autoUpdater.checkForUpdates()
      const v = r?.updateInfo?.version
      if (!v || v === app.getVersion()) return { ok: false, message: '이미 최신 버전입니다' }
      await autoUpdater.downloadUpdate()
      return { ok: true, version: v }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 다운로드된 업데이트 적용 + 재시작.
  ipcMain.handle('palace:installHubUpdate', () => {
    if (!updateFeed) throw new Error('업데이트 피드가 연결되지 않았습니다.')
    setImmediate(() => autoUpdater.quitAndInstall())
  })

  createWindow()

  // 부팅 자동화: 로그인 항목(palace + cmux) 동기화. 로그인으로 자동 실행됐을 땐
  // cmux 도 띄워 도구들(cmux-remote·loops)이 각자의 훅/supervisor 로 붙게 한다.
  // settings.launchAtLogin === false 면 로그인 항목을 건드리지 않는다.
  {
    const s = loadSettings()
    const shell = s.shell
    if (s.launchAtLogin !== false) {
      void syncLoginItems(shell)
      if (app.getLoginItemSettings().wasOpenedAtLogin) void ensureCmuxRunning(shell)
    }
    // 설치된 도구들의 자동시작(훅/supervisor)을 멱등 배선 — 이미 다 깔린 컴퓨터도
    // palace 만 켜면 걸린다. 이미 배선돼 있으면 no-op.
    if (s.autoWireTools !== false) void appManager?.wireAllAutostart()
  }

  // 허브 자체 자동업데이트: 패키징 빌드에서만 시작 시 확인 → 있으면 다운로드+알림.
  // (macOS 무음 적용은 서명 필요 — 서명 전엔 확인/알림까지 동작)
  if (app.isPackaged && updateFeed) {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {
      /* 릴리즈 피드 없거나 오프라인 — 무시 */
    })
  }

  // 전원이 바뀌면 슬립 차단 여부가 뒤집힌다(배터리에선 안 잡는다) — 폴링을 기다리지 않고 반영.
  watchPowerSource(() => schedulePush())

  // 주기적 헬스 폴링(포트 열림/닫힘, cmux 에서 켠 것 반영)
  const poll = setInterval(() => schedulePush(), 4000)
  app.on('before-quit', () => clearInterval(poll))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  appManager?.killAll()
})
