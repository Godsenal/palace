import { useCallback, useEffect, useState } from 'react'
import { palace } from '../api'
import type { AppView, ChangesView } from '../../../shared/types'

export function Changes({ app }: { app: AppView }): JSX.Element {
  const [data, setData] = useState<ChangesView | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    palace
      .getChanges(app.manifest.id)
      .then(setData)
      .finally(() => setLoading(false))
  }, [app.manifest.id])

  useEffect(load, [load])

  if (app.installState !== 'installed') {
    return <div className="pane"><div className="empty">설치 후 변경사항을 볼 수 있어요.</div></div>
  }

  return (
    <div className="pane">
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="grow" style={{ flex: 1 }}>
          <span className="faint">원격 대비 이 리포의 상태 · <span className="mono">{data?.branch ?? ''}</span></span>
        </div>
        <button className="btn sm" onClick={load} disabled={loading}>
          {loading ? <span className="spin" /> : '↻'} 새로고침(fetch)
        </button>
      </div>

      {loading && !data && <div className="empty"><span className="spin" /> git fetch 중…</div>}

      {data && data.clean && (
        <div className="notes" style={{ borderColor: 'rgba(74,222,128,0.3)', background: 'rgba(74,222,128,0.06)' }}>
          <span>✓</span>
          <span>변경 없음 — 원격과 완전히 동일하고, 커밋 안 된 로컬 수정도 없어요. “설정 적용”을 눌러도 심링크만 다시 겁니다.</span>
        </div>
      )}

      {data && !data.clean && (
        <>
          <div className="chips" style={{ marginBottom: 16 }}>
            {data.behind > 0 && <span className="chip warn">↓ {data.behind} 들어올 커밋</span>}
            {data.ahead > 0 && <span className="chip">↑ {data.ahead} 로컬 전용 커밋</span>}
            {data.dirty.length > 0 && <span className="chip bad">✎ {data.dirty.length} uncommitted</span>}
          </div>

          {data.dirty.length > 0 && (
            <div className="card">
              <h3>커밋 안 된 로컬 변경</h3>
              {data.dirty.map((d, i) => (
                <div className="prereq" key={i} style={{ padding: '7px 0' }}>
                  <span className="mono" style={{ width: 28, color: 'var(--amber)' }}>{d.status || '?'}</span>
                  <span className="mono grow" style={{ flex: 1 }}>{d.file}</span>
                </div>
              ))}
              <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>
                install.sh 는 기존 파일을 <span className="mono">.bak.&lt;시각&gt;</span> 로 백업하니 덮어써도 원본은 보존돼요.
              </div>
            </div>
          )}

          {data.incoming.length > 0 && (
            <div className="card">
              <h3>“설정 적용” 시 원격에서 들어올 커밋</h3>
              {data.incoming.map((c) => (
                <div className="prereq" key={c.sha} style={{ padding: '7px 0' }}>
                  <span className="mono" style={{ width: 68, color: 'var(--accent)' }}>{c.sha}</span>
                  <span className="grow" style={{ flex: 1 }}>{c.subject}</span>
                </div>
              ))}
              {data.diffStat && <pre className="diffstat mono">{data.diffStat}</pre>}
            </div>
          )}

          {data.diff && (
            <div className="card">
              <h3>변경 내용 (diff)</h3>
              <Diff text={data.diff} />
              {data.diffTruncated && <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>…(길어서 잘림 — 전체는 터미널에서)</div>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Diff({ text }: { text: string }): JSX.Element {
  return (
    <pre className="diff mono">
      {text.split('\n').map((line, i) => {
        let cls = ''
        if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add'
        else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del'
        else if (line.startsWith('@@')) cls = 'hunk'
        else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) cls = 'meta'
        return (
          <span key={i} className={`dl ${cls}`}>
            {line || ' '}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}
