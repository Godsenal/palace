import { runCapture } from './exec'
import { loadManifests, resolveDir } from './registry'
import { loadSettings } from './paths'
import type { OnboardingState, OnboardingStep, Settings } from '../shared/types'

/** 온보딩 각 단계의 라이브 상태를 계산한다(상태 인식형 — 이미 된 건 ✓). */
export async function computeOnboarding(settings: Settings): Promise<OnboardingState> {
  const shell = settings.shell
  const manifests = loadManifests()

  // ① GitHub 인증 — gh 우선, 없으면 SSH 키 테스트
  const github = await checkGithub(shell)

  // ② Tailscale — 데몬 Running 여부
  const tailscale = await checkTailscale(shell)

  // ③ dotfiles 설치 여부
  const df = manifests.find((m) => m.id === 'dotfiles')
  const dfInstalled = df ? resolveDir(df, settings).installed : false

  // ④ 도구(서버형 앱) 설치 진행
  const tools = manifests.filter((m) => m.id !== 'dotfiles' && (m.start || m.dashboard))
  const installedTools = tools.filter((m) => resolveDir(m, settings).installed)

  const steps: OnboardingStep[] = [
    {
      key: 'github',
      title: 'GitHub 인증',
      hint: '저장소 clone 에 필요. 새 컴퓨터에서 한 번만.',
      ok: github.ok,
      detail: github.detail,
      actionable: !github.ok,
      actionLabel: '터미널에서 로그인'
    },
    {
      key: 'tailscale',
      title: 'Tailscale',
      hint: 'cmux-remote·loops 원격/푸시용 사설망. 로그인은 앱에서.',
      ok: tailscale.ok,
      detail: tailscale.detail,
      actionable: !tailscale.ok,
      actionLabel: tailscale.installed ? 'Tailscale 열기' : '설치 + 열기'
    },
    {
      key: 'dotfiles',
      title: 'dotfiles 설치',
      hint: '셸·git·ssh·claude 설정 복원(install.sh 심링크).',
      ok: dfInstalled,
      detail: dfInstalled ? '적용됨' : '아직 안 됨',
      actionable: !dfInstalled && !!df,
      actionLabel: 'dotfiles 설치'
    },
    {
      key: 'tools',
      title: '도구 설치',
      hint: 'loops·cmux-remote 등. 각 카드에서 설치.',
      ok: tools.length > 0 && installedTools.length === tools.length,
      detail: tools.length === 0 ? '카탈로그 비어있음' : `${installedTools.map((m) => m.name).join(', ') || '아직 없음'}`,
      progress: `${installedTools.length}/${tools.length}`,
      actionable: installedTools.length < tools.length,
      actionLabel: '카탈로그 열기'
    }
  ]

  return {
    steps,
    allDone: steps.every((s) => s.ok),
    dismissed: !!settings.onboardingDismissed
  }
}

async function checkGithub(shell?: string): Promise<{ ok: boolean; detail: string }> {
  const gh = await runCapture('gh auth status >/dev/null 2>&1 && gh api user -q .login 2>/dev/null || true', undefined, shell, 15_000)
  const login = gh.stdout.trim()
  if (login) return { ok: true, detail: `gh: ${login}` }
  // SSH 키 폴백
  const ssh = await runCapture(
    'ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 | grep -oiE "Hi [A-Za-z0-9-]+" || true',
    undefined,
    shell,
    12_000
  )
  const m = ssh.stdout.trim()
  if (m) return { ok: true, detail: `ssh: ${m.replace(/^Hi /i, '')}` }
  return { ok: false, detail: '미인증 (gh 로그인 또는 SSH 키 필요)' }
}

async function checkTailscale(shell?: string): Promise<{ ok: boolean; detail: string; installed: boolean }> {
  const res = await runCapture('tailscale status --json 2>/dev/null || true', undefined, shell, 12_000)
  try {
    const j = JSON.parse(res.stdout)
    const running = j.BackendState === 'Running'
    const dns = String((j.Self && j.Self.DNSName) || '').replace(/\.$/, '')
    return { ok: running, detail: running ? dns || '연결됨' : `설치됨 · ${j.BackendState}`, installed: true }
  } catch {
    const inst = await runCapture(
      'command -v tailscale >/dev/null 2>&1 || test -d "/Applications/Tailscale.app"',
      undefined,
      shell,
      6000
    )
    const installed = inst.code === 0
    return { ok: false, detail: installed ? '로그인 필요' : '미설치', installed }
  }
}

/** Terminal.app 에서 대화형 명령 실행(cmux 없이도 되게 — 부트스트랩용). */
export async function openInTerminal(cmd: string, shell?: string): Promise<void> {
  const script = `osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "${cmd.replace(/"/g, '\\"')}"'`
  await runCapture(script, undefined, shell, 8000)
}

export function currentSettings(): Settings {
  return loadSettings()
}
