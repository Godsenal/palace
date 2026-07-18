import { useCallback, useEffect, useState } from 'react'
import { palace } from '../api'
import type { OnboardingState, OnboardingKey } from '../../../shared/types'

export function Onboarding({
  onClose,
  onGoCatalog,
  showToast
}: {
  onClose: (dismiss: boolean) => void
  onGoCatalog: () => void
  showToast: (m: string) => void
}): JSX.Element {
  const [state, setState] = useState<OnboardingState | null>(null)
  const [busy, setBusy] = useState<OnboardingKey | null>(null)
  const [checking, setChecking] = useState(false)

  const refresh = useCallback(async () => {
    setChecking(true)
    try {
      setState(await palace.getOnboarding())
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const doAction = async (key: OnboardingKey): Promise<void> => {
    if (key === 'tools') {
      onClose(false)
      onGoCatalog()
      return
    }
    setBusy(key)
    try {
      const r = await palace.onboardingAction(key)
      showToast(r.message)
      // dotfiles 는 즉시, 로그인류는 사용자가 끝낸 뒤 "다시 확인"
      if (key === 'dotfiles') setTimeout(refresh, 1500)
    } catch (e) {
      showToast(`⚠ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const done = state?.steps.filter((s) => s.ok).length ?? 0
  const total = state?.steps.length ?? 4

  return (
    <div className="overlay" onClick={() => onClose(false)}>
      <div className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <h2>👑 새 컴퓨터 셋업</h2>
            <div className="sub" style={{ marginBottom: 0 }}>
              이 앱 하나로 개발환경을 복원합니다. 이미 된 단계는 ✓ — 클릭할 필요 없어요.
            </div>
          </div>
          <div className="chip" style={{ marginTop: 6 }}>
            {done}/{total} 완료
          </div>
        </div>

        {state?.allDone && (
          <div className="notes" style={{ marginTop: 16, borderColor: 'rgba(74,222,128,0.3)', background: 'rgba(74,222,128,0.06)' }}>
            <span>✓</span>
            <span>이 컴퓨터는 이미 전부 셋업됐어요. 그냥 쓰시면 됩니다.</span>
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          {state?.steps.map((s, i) => (
            <div className="prereq" key={s.key} style={{ alignItems: 'flex-start', gap: 12, padding: '13px 0' }}>
              <span className="pstat" style={{ fontSize: 18, marginTop: 1 }}>
                {s.ok ? '✅' : <span className="stepnum">{i + 1}</span>}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {s.title}
                  {s.progress && <span className="faint" style={{ fontWeight: 400, marginLeft: 8 }}>{s.progress}</span>}
                </div>
                <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>{s.hint}</div>
                {s.detail && (
                  <div className={s.ok ? 'dim' : 'faint'} style={{ fontSize: 11.5, marginTop: 3, fontFamily: 'var(--mono)' }}>
                    {s.detail}
                  </div>
                )}
              </div>
              {!s.ok && s.actionable && (
                <button className="btn sm primary" disabled={!!busy} onClick={() => doAction(s.key)}>
                  {busy === s.key ? <span className="spin" /> : ''} {s.actionLabel}
                </button>
              )}
              {s.ok && <span className="chip ok" style={{ fontSize: 10 }}>완료</span>}
            </div>
          ))}
        </div>

        <div className="modal-foot" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="btn ghost sm" onClick={refresh} disabled={checking}>
            {checking ? <span className="spin" /> : '↻'} 다시 확인
          </button>
          <div className="row">
            <button className="btn ghost" onClick={() => onClose(true)}>
              다시 보지 않기
            </button>
            <button className="btn primary" onClick={() => onClose(false)}>
              {state?.allDone ? '완료' : '나중에'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
