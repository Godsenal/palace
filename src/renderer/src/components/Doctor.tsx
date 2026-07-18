import { useEffect, useState } from 'react'
import { palace } from '../api'
import type { AppView, PrereqResult } from '../../../shared/types'

export function Doctor({ app, showToast }: { app: AppView; showToast: (m: string) => void }): JSX.Element {
  const [results, setResults] = useState<PrereqResult[] | null>(null)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const runCheck = (): void => {
    setRunning(true)
    palace
      .runDoctor(app.manifest.id)
      .then(setResults)
      .finally(() => setRunning(false))
  }

  useEffect(runCheck, [app.manifest.id])

  const installOne = async (name: string): Promise<void> => {
    setBusy(name)
    try {
      const r = await palace.installPrereq(app.manifest.id, name)
      setResults((prev) => (prev ? prev.map((x) => (x.name === name ? r : x)) : prev))
      showToast(r.ok ? `${name} 설치 완료` : `${name} 설치 실패 — 로그 탭 확인`)
    } catch (e) {
      showToast(`⚠ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const installAll = async (): Promise<void> => {
    setBusy('__all__')
    try {
      const r = await palace.installAllPrereqs(app.manifest.id)
      setResults(r)
      showToast('자동설치 가능한 항목을 모두 처리했어요')
    } catch (e) {
      showToast(`⚠ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const prereqs = app.manifest.prerequisites ?? []
  if (prereqs.length === 0) {
    return <div className="pane"><div className="empty">이 앱은 전제 도구 목록이 없습니다.</div></div>
  }

  const missingAuto = (results ?? []).filter((r) => !r.ok && !r.manual && r.install)
  const missingManual = (results ?? []).filter((r) => !r.ok && r.manual && !r.optional)

  return (
    <div className="pane">
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>전제 도구 점검 · 자동 설치</h3>
          {missingAuto.length > 0 && (
            <button className="btn primary sm" onClick={installAll} disabled={!!busy}>
              {busy === '__all__' ? <span className="spin" /> : '⤓'} 누락 {missingAuto.length}개 자동설치
            </button>
          )}
          <button className="btn sm" onClick={runCheck} disabled={running || !!busy}>
            {running ? <span className="spin" /> : '↻'} 다시 점검
          </button>
        </div>
        {results === null && <div className="faint" style={{ padding: '12px 0' }}><span className="spin" /> 점검 중…</div>}
        {results?.map((r) => (
          <div className="prereq" key={r.name}>
            <span className="pstat">{r.ok ? '✅' : r.optional ? '➖' : '❌'}</span>
            <span className="pname">
              {r.name}
              {r.optional && <span className="faint" style={{ fontWeight: 400 }}> (선택)</span>}
            </span>
            <span className="pdetail">{r.ok ? r.detail : r.manual ? r.note ?? '수동 설치 필요' : r.detail}</span>
            {!r.ok && r.manual && r.install && (
              <>
                <span className="chip warn" style={{ fontSize: 10 }}>수동</span>
                <button className="btn ghost sm" onClick={() => { palace.writeClipboard(r.install!); showToast(`명령 복사됨: ${r.install}`) }}>
                  복사
                </button>
              </>
            )}
            {!r.ok && !r.manual && r.install && (
              <button className="btn sm" onClick={() => installOne(r.name)} disabled={!!busy}>
                {busy === r.name ? <span className="spin" /> : '⤓'} 자동 설치
              </button>
            )}
          </div>
        ))}
      </div>

      {results && missingAuto.length === 0 && missingManual.length === 0 && (
        <div className="notes"><span>✓</span><span>필수 전제 도구가 모두 갖춰졌습니다. 이제 설치·실행할 수 있어요.</span></div>
      )}
      {missingManual.length > 0 && (
        <div className="notes" style={{ borderColor: 'rgba(251,191,36,0.3)', background: 'rgba(251,191,36,0.06)' }}>
          <span>⚠</span>
          <span>
            <b>{missingManual.map((r) => r.name).join(', ')}</b> 는 palace 가 자동설치할 수 없어요(관리자 암호·시스템 GUI·계정 로그인).
            각 항목 <b>복사</b> 로 명령을 받아 터미널에서 한 번만 실행하면 나머지는 자동설치됩니다.
          </span>
        </div>
      )}
      <div className="faint" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.6 }}>
        진행 로그는 <b>로그</b> 탭의 <span className="mono">[doctor]</span> 스트림에서 실시간으로 볼 수 있어요.
      </div>
    </div>
  )
}
