import { useEffect, useMemo, useRef, useState } from 'react'
import { palace } from '../../api'
import type { AutomationRun, AutomationSnapshot, RunDetail, RunLog } from '../../../../shared/automation'
import { BusyLabel, EmptyState, Icon, InlineError, formatTime, runStatusLabel, statusTone } from './ui'

interface Props {
  snapshot: AutomationSnapshot
  active: boolean
  showToast: (message: string) => void
}

export function RunsView({ snapshot, active, showToast }: Props): JSX.Element {
  const runs = useMemo(() => [...snapshot.runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [snapshot.runs])
  const [selectedId, setSelectedId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('run'))
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const latestSeq = useRef(0)

  useEffect(() => {
    if (!selectedId && runs[0]) setSelectedId(runs[0].id)
    if (selectedId && !runs.some((run) => run.id === selectedId)) setSelectedId(runs[0]?.id ?? null)
    if (selectedId && runs.some((run) => run.id === selectedId)) {
      const url = new URL(window.location.href)
      if (url.searchParams.has('run')) {
        url.searchParams.delete('run')
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
      }
    }
  }, [runs, selectedId])

  useEffect(() => {
    if (!active || !selectedId) { if (!selectedId) setDetail(null); return }
    let alive = true
    latestSeq.current = 0
    setDetail(null)
    setLoading(true)
    setError(null)
    const load = async (): Promise<void> => {
      try {
        const next = await palace.automation.runDetail(selectedId, latestSeq.current || undefined)
        if (!alive) return
        setDetail((current) => {
          const logs = mergeLogs(current?.logs ?? [], next.logs)
          latestSeq.current = logs.length ? logs[logs.length - 1].seq : 0
          return { run: next.run, logs }
        })
        setError(null)
      } catch (reason) {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 1500)
    return () => { alive = false; window.clearInterval(timer) }
  }, [active, selectedId])

  const cancel = async (): Promise<void> => {
    if (!selectedId) return
    setCancelling(true); setError(null)
    try {
      await palace.automation.cancelRun(selectedId)
      showToast('실행 취소를 요청했습니다')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCancelling(false)
    }
  }

  const activeRun = detail?.run ?? runs.find((run) => run.id === selectedId) ?? null
  const canCancel = !!activeRun && ['queued', 'running', 'checking'].includes(activeRun.status)

  return <section className="auto-page auto-page--runs" aria-labelledby="runs-title">
    <header className="auto-page__header">
      <div><div className="auto-eyebrow">실행 기록</div><h1 id="runs-title">Runs</h1><p>각 시도의 상태, 작업 디렉터리, 검사와 OMP 로그를 실시간으로 확인합니다.</p></div>
      <div className="auto-header-stat"><span>현재 실행</span><strong>{runs.filter((run) => ['queued', 'running', 'checking'].includes(run.status)).length}</strong></div>
    </header>
    {error && <InlineError>{error}</InlineError>}
    {runs.length === 0 ? <EmptyState title="실행 기록이 없습니다" description="Automations에서 승인된 작업을 실행하면 여기에 기록됩니다." /> :
      <div className="auto-runs-layout">
        <div className="auto-run-list" role="list" aria-label="실행 기록">
          {runs.map((run) => <RunListItem key={run.id} run={run} active={run.id === selectedId} onClick={() => setSelectedId(run.id)} />)}
        </div>
        <div className="auto-run-detail">
          {!activeRun && loading ? <div className="auto-loading-block"><BusyLabel label="실행 상세를 불러오는 중" /></div> : activeRun && <>
            <div className="auto-run-detail__head">
              <div><div className="auto-run-detail__title"><h2>{activeRun.loopName}</h2><span className={`auto-status auto-status--${statusTone(activeRun.status)}`}>{runStatusLabel[activeRun.status]}</span></div><span className="auto-mono auto-muted">{activeRun.id}</span></div>
              {canCancel && <button className="auto-button auto-button--danger-ghost" type="button" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? <BusyLabel label="취소 중" /> : <><Icon name="stop" /> 실행 취소</>}</button>}
            </div>
            <dl className="auto-run-facts">
              <div><dt>트리거</dt><dd>{activeRun.trigger}</dd></div>
              <div><dt>시도</dt><dd>{activeRun.attempt}</dd></div>
              <div><dt>시작</dt><dd>{formatTime(activeRun.startedAt || activeRun.createdAt)}</dd></div>
              <div><dt>종료</dt><dd>{formatTime(activeRun.finishedAt)}</dd></div>
              <div className="auto-run-facts--wide"><dt>Worktree</dt><dd className="auto-mono">{activeRun.worktree || '—'}</dd></div>
              <div className="auto-run-facts--wide"><dt>Branch</dt><dd className="auto-mono">{activeRun.branch || '—'}</dd></div>
            </dl>
            {activeRun.error && <div className="auto-run-error"><Icon name="warning" /><div><strong>실행 오류</strong><pre>{activeRun.error}</pre></div></div>}
            <div className="auto-log-panel">
              <div className="auto-log-panel__head"><span>증분 로그</span><span>{detail?.logs.length ?? 0} lines {canCancel && <span className="auto-live-indicator">LIVE</span>}</span></div>
              <div className="auto-run-logs" role="log" aria-live="polite" aria-label="실행 로그">
                {loading && !detail ? <div className="auto-loading-block"><BusyLabel label="로그를 불러오는 중" /></div> : detail?.logs.length ? detail.logs.map((log) => <LogRow key={log.seq} log={log} />) : <div className="auto-log-empty">아직 기록된 로그가 없습니다.</div>}
              </div>
            </div>
          </>}
        </div>
      </div>}
  </section>
}

function RunListItem({ run, active, onClick }: { run: AutomationRun; active: boolean; onClick: () => void }): JSX.Element {
  return <button type="button" role="listitem" className={`auto-run-item ${active ? 'is-active' : ''}`} onClick={onClick}>
    <span className={`auto-run-item__dot auto-run-item__dot--${statusTone(run.status)}`} />
    <span className="auto-run-item__body"><strong>{run.loopName}</strong><span>{formatTime(run.createdAt)} · 시도 {run.attempt}</span></span>
    <span className={`auto-status auto-status--${statusTone(run.status)}`}>{runStatusLabel[run.status]}</span>
    <Icon name="chevron" size={14} />
  </button>
}

function LogRow({ log }: { log: RunLog }): JSX.Element {
  return <div className={`auto-run-log auto-run-log--${log.kind}`}>
    <time>{new Date(log.at).toLocaleTimeString('ko-KR', { hour12: false })}</time>
    <span className="auto-run-log__kind">{log.kind}</span>
    <pre>{log.text}</pre>
  </div>
}

function mergeLogs(current: RunLog[], incoming: RunLog[]): RunLog[] {
  if (!incoming.length) return current
  const bySequence = new Map(current.map((log) => [log.seq, log]))
  for (const log of incoming) bySequence.set(log.seq, log)
  return [...bySequence.values()].sort((a, b) => a.seq - b.seq)
}
