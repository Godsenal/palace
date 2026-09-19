import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(process.env.CMUX_OMP_HOME || join(homedir(), '.cmux-omp'))
const label = `com.godsenal.cmux-omp.${createHash('sha256').update(root).digest('hex').slice(0, 10)}`
const domain = `gui/${process.getuid?.()}`
const target = `${domain}/${label}`
const plist = join(homedir(), 'Library/LaunchAgents', `${label}.plist`)
const entry = join(project, 'out/companion-server/companion-service.cjs')
const xml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]))
function loaded() {
  try { execFileSync('launchctl', ['print', target], { stdio: 'ignore' }); return true }
  catch { return false }
}
async function activeRuns() {
  if (!existsSync(join(root, 'service.json'))) return false
  const { port } = JSON.parse(readFileSync(join(root, 'service.json'), 'utf8'))
  const token = JSON.parse(readFileSync(join(root, 'pairing-token.json'), 'utf8'))
  const response = await fetch(`http://127.0.0.1:${port}/api`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'snapshot', args: [] }), signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw new Error('서비스 상태 확인 실패. 실행 중인 작업을 확인한 후 다시 시도하세요.')
  const value = await response.json()
  return value.result.automation.runs.some((run) => ['queued', 'running', 'checking'].includes(run.status))
}
try {
  if (process.platform !== 'darwin') throw new Error('launchd 등록은 macOS 전용입니다. 다른 OS에서는 npm run companion을 프로세스 관리자로 실행하세요.')
  const action = process.argv[2]
  if (action === 'status') {
    console.log(loaded() ? `로그인 서비스 실행 중: ${label}` : `로그인 서비스 미등록/중지: ${label}`)
  } else if (action === 'uninstall') {
    if (loaded()) {
      if (await activeRuns()) throw new Error('진행·대기 중인 자동화를 먼저 종료하세요.')
      execFileSync('launchctl', ['bootout', target], { stdio: 'inherit' })
    }
    if (existsSync(plist)) unlinkSync(plist)
    console.log('companion 로그인 등록을 제거했습니다. 설정과 실행 기록은 보존했습니다.')
  } else if (action === 'install') {
    if (loaded()) throw new Error('이미 등록되어 있습니다. 설정 변경은 companion:uninstall 후 다시 설치하세요.')
    if (!existsSync(entry)) throw new Error('먼저 npm run companion:build를 실행하세요.')
    const bundledCmux = '/Applications/cmux.app/Contents/Resources/bin/cmux'
    const cmux = existsSync(bundledCmux) ? bundledCmux : 'cmux'
    const capabilities = JSON.parse(execFileSync(cmux, ['capabilities', '--json'], { encoding: 'utf8', timeout: 5000 }))
    if (capabilities.access_mode === 'cmuxOnly') {
      throw new Error('cmuxOnly 모드에서는 launchd가 cmux 터미널에 접근할 수 없습니다. 접근 설정은 변경하지 않았습니다. cmux 안의 전용 터미널에서 npm run companion을 실행하세요.')
    }
    if (existsSync(join(root, 'service.json'))) {
      const { pid } = JSON.parse(readFileSync(join(root, 'service.json'), 'utf8'))
      let live = false
      try { process.kill(pid, 0); live = true } catch (error) { if (error.code !== 'ESRCH') throw error }
      if (live) throw new Error('수동 실행 중인 companion을 먼저 종료하세요. 같은 상태 저장소를 두 서비스가 사용하지 않습니다.')
    }
    mkdirSync(root, { recursive: true, mode: 0o700 })
    mkdirSync(dirname(plist), { recursive: true })
    const environment = { PATH: process.env.PATH || '/usr/bin:/bin', CMUX_OMP_HOME: root }
    for (const name of ['CMUX_OMP_PORT', 'CMUX_OMP_PUBLIC_URL', 'CMUX_SOCKET_PATH']) if (process.env[name]) environment[name] = process.env[name]
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(entry)}</string></array>
<key>WorkingDirectory</key><string>${xml(project)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key,value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(root, 'companion.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, 'companion.log'))}</string>
</dict></plist>\n`
    writeFileSync(join(root, 'companion.log'), '', { flag: 'a', mode: 0o600 })
    writeFileSync(plist, contents, { mode: 0o600 })
    execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' })
    console.log(`로그인 서비스를 등록했습니다: ${label}. npm run companion:status로 확인하세요.`)
  } else throw new Error('사용법: companion-launchd.mjs install|uninstall|status')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
