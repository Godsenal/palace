import { access, readdir } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import type { MachineSettings } from '../../shared/automation'
import type { SetupAPI, SetupStatus } from '../../shared/workbench'
import { runCapture } from '../exec'

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const TOOL_COMMANDS: Record<string, { name: string; check: string; install?: string; optional?: boolean }> = {
  omp: { name: 'OMP', check: 'omp --version', install: 'brew install can1357/tap/omp' },
  git: { name: 'Git', check: 'git --version', install: 'brew install git' },
  node: { name: 'Node.js · 자율 루프 엔진', check: 'node --version', install: 'brew install node' },
  gh: { name: 'GitHub', check: 'gh --version', install: 'brew install gh' },
  cmux: { name: 'cmux · OMP 개발 터미널', check: 'command -v cmux || test -x /Applications/cmux.app/Contents/Resources/bin/cmux', install: 'brew install --cask cmux' },
  tailscale: { name: 'Tailscale · 선택 도구', check: 'command -v tailscale || test -x /Applications/Tailscale.app/Contents/MacOS/Tailscale', install: 'brew install --cask tailscale', optional: true },
  bun: { name: 'Bun · 선택 확장 도구', check: 'bun --version', install: 'brew install oven-sh/bun/bun', optional: true }
}

export class SetupService implements SetupAPI {
  private cached?: { at: number; value: SetupStatus }
  private loading?: Promise<SetupStatus>
  private installing = false
  constructor(private readonly options: { root: string; getSettings(): MachineSettings }) {}

  async status(): Promise<SetupStatus> {
    if (this.cached && Date.now() - this.cached.at < 15_000) return this.cached.value
    if (this.loading) return this.loading
    this.loading = (async () => {
      const tools = await Promise.all(Object.entries(TOOL_COMMANDS).map(async ([id, spec]) => {
        const check = await runCapture(spec.check, this.options.root, undefined, 8000)
        let authenticated: boolean | undefined
        let message = check.code === 0 ? (check.stdout.trim().split('\n')[0] || '설치됨') : '설치가 필요합니다'
        if (id === 'gh' && check.code === 0) {
          authenticated = (await runCapture('env -u GITHUB_TOKEN -u GH_TOKEN gh auth status', this.options.root, undefined, 10_000)).code === 0
          message = authenticated ? 'GitHub 연결됨' : '로그인이 필요합니다'
        }
        if (id === 'tailscale' && check.code === 0) {
          const state = await runCapture('if command -v tailscale >/dev/null; then tailscale status --json; else /Applications/Tailscale.app/Contents/MacOS/Tailscale status --json; fi', this.options.root, undefined, 8000)
          try { authenticated = JSON.parse(state.stdout).BackendState === 'Running' } catch { authenticated = false }
          message = authenticated ? 'Tailnet 연결됨' : 'Tailscale 앱에서 로그인하고 연결하세요'
        }
        if (id === 'tailscale') message += ' · 기존 Loops 대시보드·SSH용 선택 도구이며 OMP 자체 Remote에는 필요하지 않습니다'
        if (id === 'omp' && check.code === 0) message += ' · 계정 연결은 OMP 로그인 또는 첫 세션에서 확인합니다'
        return { id, name: spec.name, available: check.code === 0, authenticated, optional: spec.optional, message }
      }))
      const projects = new Map<string, { name: string; path: string }>()
      for (const [name, path] of Object.entries(this.options.getSettings().projectPaths)) projects.set(path, { name, path })
      for (const parent of ['LTH', 'Projects', 'Developer', 'dev', 'code']) {
        const directory = join(homedir(), parent)
        let entries
        try { entries = await readdir(directory, { withFileTypes: true }) } catch { continue }
        for (const entry of entries.slice(0, 100)) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) continue
          const path = join(directory, entry.name)
          try { await access(join(path, '.git')); if (!projects.has(path)) projects.set(path, { name: entry.name, path }) } catch { /* Git 프로젝트만 제안 */ }
        }
      }
      const value = { tools, projects: [...projects.values()], platform: platform() }
      this.cached = { at: Date.now(), value }
      return value
    })().finally(() => { this.loading = undefined })
    return this.loading
  }

  async repositories(): Promise<Array<{ name: string; url: string; private: boolean }>> {
    const result = await runCapture('env -u GITHUB_TOKEN -u GH_TOKEN gh repo list --limit 100 --json nameWithOwner,url,isPrivate', this.options.root, undefined, 30_000)
    if (result.code !== 0) throw new Error('GitHub 저장소를 불러오지 못했습니다. 먼저 GitHub 로그인을 완료하세요.')
    const rows: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(rows)) throw new Error('GitHub 저장소 응답이 올바르지 않습니다')
    return rows.filter((row) => row && typeof row.nameWithOwner === 'string' && typeof row.url === 'string').map((row) => ({ name: row.nameWithOwner, url: row.url, private: row.isPrivate === true }))
  }

  async install(tool: 'omp' | 'gh' | 'cmux' | 'tailscale' | 'bun' | 'node' | 'git'): Promise<SetupStatus> {
    if (!Object.hasOwn(TOOL_COMMANDS, tool) || !TOOL_COMMANDS[tool].install) throw new Error('지원하지 않는 설치 대상입니다')
    if (platform() !== 'darwin') throw new Error('자동 설치는 현재 macOS Homebrew를 지원합니다. 이 OS의 공식 설치 방법을 사용하세요.')
    if (this.installing) throw new Error('다른 도구를 설치 중입니다. 완료 후 다시 시도하세요.')
    this.installing = true
    try {
      if ((await runCapture('command -v brew', this.options.root, undefined, 5000)).code !== 0) throw new Error('Homebrew가 필요합니다. https://brew.sh 에서 설치한 뒤 다시 시도하세요.')
      const result = await runCapture(TOOL_COMMANDS[tool].install!, this.options.root, undefined, 600_000)
      if (result.code !== 0) throw new Error(`설치에 실패했습니다: ${(result.stderr || result.stdout).slice(-3000)}`)
      this.cached = undefined
      return this.status()
    } finally { this.installing = false }
  }

  async login(tool: 'omp' | 'gh' | 'tailscale'): Promise<{ message: string }> {
    if (platform() !== 'darwin') throw new Error('이 OS에서는 OMP 또는 GitHub CLI에서 로그인하세요.')
    if (tool === 'tailscale') {
      const result = await runCapture('open -a Tailscale', this.options.root, undefined, 5000)
      if (result.code !== 0) throw new Error('Tailscale 앱을 먼저 설치하세요.')
    } else {
      if (tool !== 'omp' && tool !== 'gh') throw new Error('지원하지 않는 로그인 대상입니다')
      const command = tool === 'omp' ? `${this.options.getSettings().ompCommand.trim() || 'omp'} /login` : 'env -u GITHUB_TOKEN -u GH_TOKEN gh auth login --hostname github.com --git-protocol https --web'
      const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(command)}\nend tell`
      const result = await runCapture(`osascript -e ${quote(script)}`, this.options.root, undefined, 10_000)
      if (result.code !== 0) throw new Error('로그인 터미널을 열지 못했습니다. 시스템의 자동화 권한을 확인하세요.')
    }
    this.cached = undefined
    return { message: '로그인 창을 열었습니다. 인증을 마친 뒤 환경 확인을 다시 눌러주세요.' }
  }

  async chooseProject(): Promise<null> {
    throw new Error('폴더 선택은 데스크톱 앱에서 사용할 수 있습니다. 모바일에서는 등록된 프로젝트를 선택하세요.')
  }
}
