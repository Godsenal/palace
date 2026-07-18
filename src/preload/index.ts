import { contextBridge, ipcRenderer } from 'electron'
import type { PalaceAPI, LogLine, ProgressEvent, AppView } from '../shared/types'

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: PalaceAPI = {
  listApps: () => ipcRenderer.invoke('palace:listApps'),
  getApp: (id) => ipcRenderer.invoke('palace:getApp', id),
  refresh: (id) => ipcRenderer.invoke('palace:refresh', id),
  install: (id) => ipcRenderer.invoke('palace:install', id),
  update: (id) => ipcRenderer.invoke('palace:update', id),
  checkUpdate: (id) => ipcRenderer.invoke('palace:checkUpdate', id),
  start: (id) => ipcRenderer.invoke('palace:start', id),
  stop: (id) => ipcRenderer.invoke('palace:stop', id),
  openInCmux: (id) => ipcRenderer.invoke('palace:openInCmux', id),
  runDoctor: (id) => ipcRenderer.invoke('palace:doctor', id),
  installPrereq: (id, name) => ipcRenderer.invoke('palace:installPrereq', id, name),
  installAllPrereqs: (id) => ipcRenderer.invoke('palace:installAllPrereqs', id),
  readDocs: (id, path) => ipcRenderer.invoke('palace:readDocs', id, path),
  getChanges: (id) => ipcRenderer.invoke('palace:getChanges', id),
  readEnv: (id) => ipcRenderer.invoke('palace:readEnv', id),
  writeEnv: (id, entries) => ipcRenderer.invoke('palace:writeEnv', id, entries),
  seedEnvFromExample: (id) => ipcRenderer.invoke('palace:seedEnv', id),
  getSettings: () => ipcRenderer.invoke('palace:getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('palace:setSettings', patch),
  addManifest: (m) => ipcRenderer.invoke('palace:addManifest', m),
  removeManifest: (id) => ipcRenderer.invoke('palace:removeManifest', id),
  getOnboarding: () => ipcRenderer.invoke('palace:getOnboarding'),
  onboardingAction: (key) => ipcRenderer.invoke('palace:onboardingAction', key),
  dismissOnboarding: () => ipcRenderer.invoke('palace:dismissOnboarding'),
  openExternal: (url) => ipcRenderer.invoke('palace:openExternal', url),
  openDir: (id) => ipcRenderer.invoke('palace:openDir', id),
  writeClipboard: (text) => ipcRenderer.invoke('palace:writeClipboard', text),
  checkForHubUpdate: () => ipcRenderer.invoke('palace:checkHubUpdate'),
  onLog: (cb) => sub<LogLine>('palace:log', cb),
  onProgress: (cb) => sub<ProgressEvent>('palace:progress', cb),
  onStateChanged: (cb) => sub<AppView[]>('palace:state', cb)
}

contextBridge.exposeInMainWorld('palace', api)
