import { contextBridge, ipcRenderer } from 'electron'
import type { PalaceAPI, LogLine, ProgressEvent, AppView, HubProgress } from '../shared/types'

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const workbench = (namespace: string, method: string, args: unknown[] = []): Promise<any> =>
  ipcRenderer.invoke('palace:workbench', `${namespace}.${method}`, args)

const api: PalaceAPI = {
  automation: {
    snapshot: () => ipcRenderer.invoke('palace:automation', 'snapshot', []),
    saveLoop: (loop) => ipcRenderer.invoke('palace:automation', 'saveLoop', [loop]),
    deleteLoop: (id) => ipcRenderer.invoke('palace:automation', 'deleteLoop', [id]),
    approveLoop: (id) => ipcRenderer.invoke('palace:automation', 'approveLoop', [id]),
    runLoop: (id) => ipcRenderer.invoke('palace:automation', 'runLoop', [id]),
    cancelRun: (id) => ipcRenderer.invoke('palace:automation', 'cancelRun', [id]),
    runDetail: (id, after) => ipcRenderer.invoke('palace:automation', 'runDetail', [id, after ?? 0]),
    saveSettings: (settings) => ipcRenderer.invoke('palace:automation', 'saveSettings', [settings]),
    saveOmp: (omp) => ipcRenderer.invoke('palace:automation', 'saveOmp', [omp]),
    importOmp: () => ipcRenderer.invoke('palace:automation', 'importOmp', []),
    sync: (direction) => ipcRenderer.invoke('palace:automation', 'sync', [direction]),
    webhook: (id) => ipcRenderer.invoke('palace:automation', 'webhook', [id]),
    service: (action) => ipcRenderer.invoke('palace:automationService', action)
  },
  ide: {
    snapshot: () => workbench('ide', 'snapshot'),
    models: () => workbench('ide', 'models'),
    createWorkspace: (input) => workbench('ide', 'createWorkspace', [input]),
    archiveWorkspace: (id) => workbench('ide', 'archiveWorkspace', [id]),
    createSession: (input) => workbench('ide', 'createSession', [input]),
    detail: (id, after) => workbench('ide', 'detail', [id, after ?? 0]),
    prompt: (id, text, mode) => workbench('ide', 'prompt', [id, text, mode ?? 'prompt']),
    respond: (id, questionId, response) => workbench('ide', 'respond', [id, questionId, response]),
    abort: (id) => workbench('ide', 'abort', [id]),
    resume: (id) => workbench('ide', 'resume', [id]),
    closeSession: (id) => workbench('ide', 'closeSession', [id]),
    command: (id, command, args) => workbench('ide', 'command', [id, command, args ?? {}]),
    changes: (id) => workbench('ide', 'changes', [id]),
    readFile: (id, path) => workbench('ide', 'readFile', [id, path]),
    saveProfiles: (profiles) => workbench('ide', 'saveProfiles', [profiles]),
    heartbeat: (id, value) => workbench('ide', 'heartbeat', [id, value])
  },
  skills: {
    search: (query) => workbench('skills', 'search', [query]),
    preview: (source, id) => workbench('skills', 'preview', id ? [source, id] : [source]),
    list: (project) => workbench('skills', 'list', [project]),
    install: (project, source, id, revision) => workbench('skills', 'install', [project, source, id, revision]),
    update: (project, id, revision) => workbench('skills', 'update', [project, id, revision]),
    remove: (project, id) => workbench('skills', 'remove', [project, id])
  },
  loops: {
    status: () => workbench('loops', 'status'),
    start: () => workbench('loops', 'start'),
    stop: () => workbench('loops', 'stop'),
    request: (path, method, body) => workbench('loops', 'request', [path, method ?? 'GET', body ?? null])
  },
  remote: {
    status: () => workbench('remote', 'status'),
    launch: (input) => workbench('remote', 'launch', [input]),
    link: (instanceId, generation, access) => workbench('remote', 'link', [instanceId, generation, access]),
    focus: (workspaceRef) => workbench('remote', 'focus', [workspaceRef])
  },
  setup: {
    status: () => workbench('setup', 'status'),
    repositories: () => workbench('setup', 'repositories'),
    install: (tool) => workbench('setup', 'install', [tool]),
    login: (tool) => workbench('setup', 'login', [tool]),
    chooseProject: () => workbench('setup', 'chooseProject')
  },
  listApps: () => ipcRenderer.invoke('palace:listApps'),
  getApp: (id) => ipcRenderer.invoke('palace:getApp', id),
  refresh: (id) => ipcRenderer.invoke('palace:refresh', id),
  install: (id) => ipcRenderer.invoke('palace:install', id),
  update: (id) => ipcRenderer.invoke('palace:update', id),
  checkUpdate: (id) => ipcRenderer.invoke('palace:checkUpdate', id),
  start: (id) => ipcRenderer.invoke('palace:start', id),
  stop: (id) => ipcRenderer.invoke('palace:stop', id),
  setKeepAwake: (id, enabled) => ipcRenderer.invoke('palace:setKeepAwake', id, enabled),
  openInCmux: (id) => ipcRenderer.invoke('palace:openInCmux', id),
  ensureAutostart: (id) => ipcRenderer.invoke('palace:ensureAutostart', id),
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
  downloadHubUpdate: () => ipcRenderer.invoke('palace:downloadHubUpdate'),
  installHubUpdate: () => ipcRenderer.invoke('palace:installHubUpdate'),
  onHubProgress: (cb) => sub<HubProgress>('palace:hubProgress', cb),
  onLog: (cb) => sub<LogLine>('palace:log', cb),
  onProgress: (cb) => sub<ProgressEvent>('palace:progress', cb),
  onStateChanged: (cb) => sub<AppView[]>('palace:state', cb)
}

contextBridge.exposeInMainWorld('palace', api)
