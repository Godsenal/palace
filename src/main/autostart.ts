import { app } from 'electron'
import { existsSync } from 'node:fs'
import { runCapture } from './exec'

/**
 * 부팅 자동화. palace 는 "관제" 앱이므로, 새 컴퓨터에서도 palace 만 깔면 부팅 시
 * 생태계 전체가 자동으로 뜨도록 만든다. 여기서는 **환경만** 띄운다 —
 * 실제 도구(cmux-remote·loops) 기동은 각 도구가 자기 방식으로 한다:
 *   • cmux-remote: install-autostart.sh 가 심은 ~/.zshrc 훅이 cmux 터미널에서 발동
 *   • loops:       install.sh 가 등록한 launchd supervisor(60s)가 재기동
 * palace 가 서버를 직접 spawn 하면 위 경로와 포트가 충돌하므로 하지 않는다.
 */

const CMUX_APP = '/Applications/cmux.app'

/** 로그인 항목 동기화: palace 자신(네이티브) + cmux(System Events). 멱등. */
export async function syncLoginItems(shell?: string): Promise<void> {
  if (process.platform !== 'darwin') return

  // palace 자신 — 네이티브 API(멱등). 개발 실행에선 스킵(패키징된 앱만 등록).
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: true })
    } catch {
      /* noop */
    }
  }

  // cmux — 설치돼 있을 때만, 없으면 추가(System Events). 이미 있으면 그대로.
  if (existsSync(CMUX_APP)) {
    const osa =
      'tell application "System Events" to if not (exists login item "cmux") then ' +
      `make login item at end with properties {path:"${CMUX_APP}", hidden:false}`
    await runCapture(`osascript -e ${JSON.stringify(osa)}`, undefined, shell, 8000).catch(() => undefined)
  }
}

/** cmux 가 안 떠 있으면 띄운다(도구 자동시작이 붙을 수 있도록). best-effort. */
export async function ensureCmuxRunning(shell?: string): Promise<void> {
  if (process.platform !== 'darwin' || !existsSync(CMUX_APP)) return
  const running = await runCapture('pgrep -f "/Applications/cmux.app" >/dev/null 2>&1', undefined, shell, 5000).catch(
    () => ({ code: 1 }) as { code: number }
  )
  if (running.code === 0) return // 이미 실행 중
  await runCapture('open -a cmux 2>/dev/null || true', undefined, shell, 5000).catch(() => undefined)
}
