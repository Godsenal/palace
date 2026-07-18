import { ipcMain, shell, clipboard, BrowserWindow } from 'electron'
import type { AppManager } from './appManager'
import { loadSettings, saveSettings } from './paths'
import { loadManifests, saveUserManifest, removeUserManifest, resolveDir } from './registry'
import type { Manifest, Settings } from '../shared/types'

export function registerIpc(am: AppManager): void {
  const h = ipcMain.handle.bind(ipcMain)

  h('palace:listApps', () => am.listApps())
  h('palace:getApp', (_e, id: string) => am.getApp(id))
  h('palace:refresh', () => am.listApps())

  h('palace:install', (_e, id: string) => am.install(id))
  h('palace:update', (_e, id: string) => am.update(id))
  h('palace:checkUpdate', (_e, id: string) => am.checkUpdate(id))
  h('palace:start', (_e, id: string) => am.start(id))
  h('palace:stop', (_e, id: string) => am.stop(id))
  h('palace:openInCmux', (_e, id: string) => am.openInCmux(id))
  h('palace:doctor', (_e, id: string) => am.doctor(id))
  h('palace:installPrereq', (_e, id: string, name: string) => am.installPrereq(id, name))
  h('palace:installAllPrereqs', (_e, id: string) => am.installAllPrereqs(id))
  h('palace:readDocs', (_e, id: string, path?: string) => am.readDocs(id, path))
  h('palace:readEnv', (_e, id: string) => am.readEnv(id))
  h('palace:writeEnv', (_e, id: string, entries) => am.writeEnvFile(id, entries))
  h('palace:seedEnv', (_e, id: string) => am.seedEnvFromExample(id))

  h('palace:getSettings', () => loadSettings())
  h('palace:setSettings', async (_e, patch: Partial<Settings>) => {
    const s = saveSettings(patch)
    am.notifyState() // 설치 루트 변경 등 → 상태 재계산
    return s
  })

  h('palace:addManifest', async (_e, m: Manifest) => {
    saveUserManifest(m)
    return am.listApps()
  })
  h('palace:removeManifest', async (_e, id: string) => {
    removeUserManifest(id)
    return am.listApps()
  })

  h('palace:openExternal', (_e, url: string) => shell.openExternal(url))
  h('palace:openDir', (_e, id: string) => {
    const m = loadManifests().find((x) => x.id === id)
    if (!m) return
    const { dir, installed } = resolveDir(m, loadSettings())
    if (installed) return shell.openPath(dir)
  })
  h('palace:writeClipboard', (_e, text: string) => {
    clipboard.writeText(text)
  })
}

/** 모든 창으로 브로드캐스트. */
export function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}
