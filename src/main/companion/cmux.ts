import { execFile as execFileCallback } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { AutomationRun } from '../../shared/automation'
import type { CmuxKey, CmuxSnapshot } from '../../shared/companion'

const execFile = promisify(execFileCallback)

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const COMMAND_TIMEOUT_MS = 8_000
const DISCOVERY_TIMEOUT_MS = 12_000
const MAX_DISCOVERY_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024
const MAX_SCREEN_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_SCREEN_BYTES = 256 * 1024
const MAX_SCREEN_LINES = 200
const MAX_SEND_BYTES = 32 * 1024
const MAX_SURFACES = 2_000

const ACTIVE_RUN_STATUSES: Partial<Record<AutomationRun['status'], true>> = {
  queued: true,
  running: true,
  checking: true
}
const FINISHED_RUN_STATUSES: Partial<Record<AutomationRun['status'], true>> = {
  succeeded: true,
  'needs-review': true,
  failed: true,
  cancelled: true,
  interrupted: true
}
const KEY_NAMES: Record<CmuxKey, string> = {
  Enter: 'enter',
  Escape: 'escape',
  'Ctrl+C': 'ctrl+c',
  Up: 'up',
  Down: 'down',
  Tab: 'tab'
}

interface TreeSurface {
  id: string
  title: string
  type: string
}

interface TreeWorkspace {
  id: string
  title: string
  surfaces: TreeSurface[]
}

interface TreeWindow {
  id: string
  active: boolean
  current: boolean
  key: boolean
  workspaces: TreeWorkspace[]
}

interface CmuxTopology {
  windows: TreeWindow[]
}

interface TerminalTarget {
  windowId: string
  workspaceId: string
  surfaceId: string
}

interface CommandError extends Error {
  code?: string | number | null
  killed?: boolean
  signal?: NodeJS.Signals | null
  stdout?: string | Buffer
  stderr?: string | Buffer
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requiredArray(row: Record<string, unknown>, field: string, label: string): unknown[] {
  const value = row[field]
  if (!Array.isArray(value)) throw new Error(`cmux ${label} 응답에 ${field} 배열이 없습니다`)
  return value
}

function requiredUuid(row: Record<string, unknown>, field: string, label: string): string {
  const value = row[field]
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`cmux ${label} 응답의 ${field}가 유효한 UUID가 아닙니다`)
  }
  return value.toUpperCase()
}

function boundedLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()
  return clean ? clean.slice(0, 240) : fallback
}

function parseJson(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout) as unknown
  } catch {
    throw new Error(`cmux ${label} 응답이 유효한 JSON이 아닙니다`)
  }
}

function parseTopology(stdout: string): CmuxTopology {
  const root = objectRecord(parseJson(stdout, '트리'))
  if (!root) throw new Error('cmux 트리 응답 형식이 올바르지 않습니다')

  const windows: TreeWindow[] = []
  let surfaceCount = 0
  for (const rawWindow of requiredArray(root, 'windows', '트리')) {
    const window = objectRecord(rawWindow)
    if (!window) throw new Error('cmux 트리의 window 형식이 올바르지 않습니다')
    const windowId = requiredUuid(window, 'id', 'window')
    const workspaces: TreeWorkspace[] = []

    for (const rawWorkspace of requiredArray(window, 'workspaces', 'window')) {
      const workspace = objectRecord(rawWorkspace)
      if (!workspace) throw new Error('cmux 트리의 workspace 형식이 올바르지 않습니다')
      const workspaceId = requiredUuid(workspace, 'id', 'workspace')
      const surfaces: TreeSurface[] = []

      for (const rawPane of requiredArray(workspace, 'panes', 'workspace')) {
        const pane = objectRecord(rawPane)
        if (!pane) throw new Error('cmux 트리의 pane 형식이 올바르지 않습니다')
        for (const rawSurface of requiredArray(pane, 'surfaces', 'pane')) {
          const surface = objectRecord(rawSurface)
          if (!surface || typeof surface.type !== 'string') {
            throw new Error('cmux 트리의 surface 형식이 올바르지 않습니다')
          }
          surfaceCount += 1
          if (surfaceCount > MAX_SURFACES) throw new Error(`cmux surface가 ${MAX_SURFACES}개를 넘어 목록을 안전하게 표시할 수 없습니다`)
          surfaces.push({
            id: requiredUuid(surface, 'id', 'surface'),
            title: boundedLabel(surface.title, '이름 없는 surface'),
            type: surface.type
          })
        }
      }

      workspaces.push({
        id: workspaceId,
        title: boundedLabel(workspace.title, '이름 없는 workspace'),
        surfaces
      })
    }

    windows.push({
      id: windowId,
      active: window.active === true,
      current: window.current === true,
      key: window.key === true,
      workspaces
    })
  }
  return { windows }
}

function validateUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${label}는 전체 UUID 형식이어야 합니다`)
  }
  return value.toUpperCase()
}

function validatePasteText(text: string): void {
  if (typeof text !== 'string' || text.length === 0) throw new Error('보낼 텍스트가 비어 있습니다')
  if (Buffer.byteLength(text, 'utf8') > MAX_SEND_BYTES) {
    throw new Error(`보낼 텍스트는 ${MAX_SEND_BYTES / 1024}KB를 넘을 수 없습니다`)
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error('보낼 텍스트에 줄바꿈, 탭 또는 제어 문자를 포함할 수 없습니다. Enter와 Tab은 키 명령을 사용하세요')
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function truncateUtf8FromEnd(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const prefix = '…\n'
  const bytes = Buffer.from(text, 'utf8')
  const payloadBytes = maxBytes - Buffer.byteLength(prefix, 'utf8')
  let start = bytes.length - payloadBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1
  return prefix + bytes.subarray(start).toString('utf8')
}

function safeErrorDetail(value: unknown): string {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : typeof value === 'string' ? value : ''
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400)
}

function cmuxError(error: unknown, action: string): Error {
  const detail = error as CommandError
  const combined = `${safeErrorDetail(detail.stderr)} ${safeErrorDetail(detail.stdout)} ${safeErrorDetail(detail.message)}`.trim()
  if (detail.killed || detail.signal === 'SIGTERM' || /timed out|timeout/i.test(combined)) {
    return new Error(`${action} 중 cmux 응답 시간이 초과되었습니다`)
  }
  if (detail.code === 'ENOENT') {
    return new Error('cmux CLI를 찾을 수 없습니다. cmux가 설치되어 있는지 확인하세요')
  }
  if (/unauthori[sz]ed|forbidden|authentication|password|permission denied|access denied|cmuxonly|not allowed/i.test(combined)) {
    return new Error(`${action} 권한이 없습니다. cmux Settings의 Socket Access를 확인하세요. cmuxOnly 모드에서는 cmux 밖에서 실행되는 컴패니언 서비스가 접근할 수 없으며, 이 서비스는 접근 모드를 자동으로 변경하지 않습니다`)
  }
  if (/connection refused|failed to connect|connect.*socket|no such file.*(?:cmux|sock)|socket.*not found|econnrefused/i.test(combined)) {
    return new Error(`${action}에 연결할 수 없습니다. cmux 앱이 실행 중인지와 제어 소켓 설정을 확인하세요`)
  }
  return new Error(combined ? `${action}에 실패했습니다: ${combined}` : `${action}에 실패했습니다`)
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CMUX_QUIET: '1' }
  delete env.CMUX_WORKSPACE_ID
  delete env.CMUX_SURFACE_ID
  delete env.CMUX_TAB_ID
  return env
}

export class CmuxBridge {
  private binary?: string

  async snapshot(): Promise<CmuxSnapshot> {
    try {
      const topology = await this.topology()
      return {
        available: true,
        surfaces: topology.windows.flatMap((window) =>
          window.workspaces.flatMap((workspace) =>
            workspace.surfaces
              .filter((surface) => surface.type === 'terminal')
              .map((surface) => ({
                workspaceId: workspace.id,
                surfaceId: surface.id,
                workspaceName: workspace.title,
                title: surface.title
              }))
          )
        )
      }
    } catch (error) {
      return {
        available: false,
        surfaces: [],
        error: error instanceof Error ? error.message : 'cmux 상태를 확인할 수 없습니다'
      }
    }
  }

  async read(workspaceId: string, surfaceId: string): Promise<{ text: string }> {
    const target = await this.terminalTarget(workspaceId, surfaceId)
    const { stdout } = await this.runCmux([
      'read-screen',
      '--window', target.windowId,
      '--workspace', target.workspaceId,
      '--surface', target.surfaceId,
      '--scrollback',
      '--lines', String(MAX_SCREEN_LINES),
      '--json',
      '--id-format', 'uuids'
    ], 'cmux 화면 읽기', COMMAND_TIMEOUT_MS, MAX_SCREEN_COMMAND_OUTPUT_BYTES)
    const response = objectRecord(parseJson(stdout, '화면 읽기'))
    if (!response || typeof response.text !== 'string') throw new Error('cmux 화면 읽기 응답에 text가 없습니다')
    return { text: truncateUtf8FromEnd(response.text, MAX_SCREEN_BYTES) }
  }

  async send(workspaceId: string, surfaceId: string, text: string): Promise<void> {
    validatePasteText(text)
    const target = await this.terminalTarget(workspaceId, surfaceId)
    const params = JSON.stringify({
      window_id: target.windowId,
      workspace_id: target.workspaceId,
      surface_id: target.surfaceId,
      text
    })
    await this.runCmux(['rpc', 'surface.send_text', params], 'cmux 텍스트 전송', COMMAND_TIMEOUT_MS, MAX_COMMAND_OUTPUT_BYTES)
  }

  async key(workspaceId: string, surfaceId: string, key: CmuxKey): Promise<void> {
    const keyName = KEY_NAMES[key]
    if (!keyName) throw new Error('지원하지 않는 cmux 키입니다')
    const target = await this.terminalTarget(workspaceId, surfaceId)
    await this.runCmux([
      'send-key',
      '--window', target.windowId,
      '--workspace', target.workspaceId,
      '--surface', target.surfaceId,
      '--', keyName
    ], 'cmux 키 전송', COMMAND_TIMEOUT_MS, MAX_COMMAND_OUTPUT_BYTES)
  }

  async openRun(run: AutomationRun, ompCommand: string): Promise<void> {
    if (ACTIVE_RUN_STATUSES[run.status]) {
      throw new Error('실행 중인 자동화는 cmux에서 다시 열 수 없습니다')
    }
    if (!FINISHED_RUN_STATUSES[run.status] || !run.finishedAt) {
      throw new Error('완료된 자동화 실행만 cmux에서 열 수 있습니다')
    }
    if (!run.worktree?.trim()) throw new Error('이 실행의 worktree 경로가 없습니다')
    if (!run.sessionFile?.trim()) throw new Error('이 실행의 OMP 세션 파일이 없습니다')

    const command = ompCommand.trim()
    if (!command) throw new Error('OMP 실행 명령이 구성되지 않았습니다')
    if (command.length > 4_096 || /[\u0000-\u001f\u007f-\u009f]/u.test(command)) {
      throw new Error('OMP 실행 명령에 허용되지 않는 문자가 있습니다')
    }

    let worktree: string
    let sessionFile: string
    try {
      const paths = await Promise.all([realpath(run.worktree), realpath(run.sessionFile)])
      worktree = paths[0]
      sessionFile = paths[1]
      const [worktreeInfo, sessionInfo] = await Promise.all([stat(worktree), stat(sessionFile)])
      if (!worktreeInfo.isDirectory()) throw new Error('worktree가 디렉터리가 아닙니다')
      if (!sessionInfo.isFile()) throw new Error('세션 경로가 파일이 아닙니다')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`완료된 실행의 파일을 찾을 수 없습니다: ${detail}`)
    }

    const topology = await this.topology()
    const targetWindow = topology.windows.find((window) => window.active)
      ?? topology.windows.find((window) => window.key)
      ?? topology.windows.find((window) => window.current)
      ?? topology.windows[0]
    if (!targetWindow) throw new Error('새 OMP 작업을 열 cmux window가 없습니다')

    // OMP v18의 저장 세션 재개 플래그는 --resume이다. cmux는 --command를 새 셸에서
    // 실행하므로 실행 파일과 세션 경로를 각각 POSIX 단일 인용해 셸 해석을 차단한다.
    const resumeCommand = `${shellQuote(command)} --resume ${shellQuote(sessionFile)}`
    const title = boundedLabel(`OMP · ${run.loopName}`, `OMP · ${run.id}`).slice(0, 120)
    await this.runCmux([
      'new-workspace',
      '--window', targetWindow.id,
      '--name', title,
      '--cwd', worktree,
      '--command', resumeCommand,
      '--focus', 'false',
      '--json',
      '--id-format', 'uuids'
    ], '완료된 OMP 실행 열기', DISCOVERY_TIMEOUT_MS, MAX_COMMAND_OUTPUT_BYTES)
  }

  private async topology(): Promise<CmuxTopology> {
    const { stdout } = await this.runCmux(
      ['tree', '--all', '--json', '--id-format', 'uuids'],
      'cmux 상태 조회',
      DISCOVERY_TIMEOUT_MS,
      MAX_DISCOVERY_OUTPUT_BYTES
    )
    return parseTopology(stdout)
  }

  private async terminalTarget(workspaceId: string, surfaceId: string): Promise<TerminalTarget> {
    const requestedWorkspace = validateUuid(workspaceId, 'workspaceId')
    const requestedSurface = validateUuid(surfaceId, 'surfaceId')
    const topology = await this.topology()

    for (const window of topology.windows) {
      const workspace = window.workspaces.find((candidate) => candidate.id === requestedWorkspace)
      if (!workspace) continue
      const surface = workspace.surfaces.find((candidate) => candidate.id === requestedSurface)
      if (!surface) {
        throw new Error('선택한 surface가 요청한 workspace에 더 이상 없습니다. 목록을 새로 고치세요')
      }
      if (surface.type !== 'terminal') throw new Error('선택한 surface는 터미널이 아닙니다')
      return {
        windowId: window.id,
        workspaceId: workspace.id,
        surfaceId: surface.id
      }
    }
    throw new Error('선택한 workspace가 더 이상 없습니다. 목록을 새로 고치세요')
  }

  private async runCmux(
    args: string[],
    action: string,
    timeout = COMMAND_TIMEOUT_MS,
    maxBuffer = MAX_COMMAND_OUTPUT_BYTES
  ): Promise<{ stdout: string; stderr: string }> {
    const binary = await this.cmuxBinary()
    try {
      const result = await execFile(binary, args, {
        encoding: 'utf8',
        env: commandEnvironment(),
        timeout,
        maxBuffer,
        windowsHide: true
      })
      return { stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      throw cmuxError(error, action)
    }
  }

  private async cmuxBinary(): Promise<string> {
    if (this.binary) return this.binary
    const candidates = [
      '/Applications/cmux.app/Contents/Resources/bin/cmux',
      join(homedir(), 'Applications/cmux.app/Contents/Resources/bin/cmux'),
      '/opt/homebrew/bin/cmux',
      '/usr/local/bin/cmux',
      join(homedir(), '.local/bin/cmux'),
      ...(process.env.PATH ?? '')
        .split(delimiter)
        .filter((directory) => isAbsolute(directory))
        .map((directory) => join(directory, 'cmux'))
    ]

    for (const candidate of new Set(candidates)) {
      try {
        await access(candidate, constants.X_OK)
        const resolved = await realpath(candidate)
        if (!isAbsolute(resolved)) continue
        const info = await stat(resolved)
        if (!info.isFile()) continue
        this.binary = resolved
        return resolved
      } catch {
        // 다음 알려진 설치 위치를 확인한다.
      }
    }
    throw new Error('cmux CLI를 찾을 수 없습니다. cmux를 설치한 뒤 다시 시도하세요')
  }
}
