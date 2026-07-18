import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import electronUpdater from 'electron-updater'
import { AppManager } from './appManager'
import { registerIpc, broadcast } from './ipc'
import { loadSettings, ensureDirs } from './paths'
import type { LogLine, ProgressEvent } from '../shared/types'

const { autoUpdater } = electronUpdater

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
    title: 'palace',
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
  app.setName('palace')

  appManager = new AppManager({
    getSettings: () => loadSettings(),
    emitLog: (l: LogLine) => broadcast('palace:log', l),
    emitProgress: (p: ProgressEvent) => broadcast('palace:progress', p),
    emitState: () => schedulePush()
  })

  registerIpc(appManager)

  // 허브 자체 업데이트 체크(패키징 후 GitHub Releases 기준). 개발중엔 조용히 실패.
  ipcMain.handle('palace:checkHubUpdate', async () => {
    try {
      autoUpdater.autoDownload = false
      const r = await autoUpdater.checkForUpdates()
      const v = r?.updateInfo?.version
      return { available: !!v && v !== app.getVersion(), version: v }
    } catch (e) {
      return { available: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  createWindow()

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
