import { useCallback, useEffect, useRef, useState } from 'react'
import { palace } from '../../api'
import type { AutomationSnapshot } from '../../../../shared/automation'
import { AutomationsView } from './AutomationsView'
import { RunsView } from './RunsView'
import { MachineView, OmpSyncView } from './ProfileViews'
import { BusyLabel, Icon } from './ui'

export type AutomationSection = 'automations' | 'runs' | 'sync' | 'machine'

export interface AutomationStatus {
  online: boolean
  machineId?: string
  version?: string
  running: number
}

export function AutomationConsole({ section, hidden, showToast, onStatusChange }: {
  section: AutomationSection
  hidden: boolean
  showToast: (message: string) => void
  onStatusChange: (status: AutomationStatus) => void
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<AutomationSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  const load = useCallback(async (manual = false): Promise<void> => {
    if (manual) setRefreshing(true)
    try {
      const next = await palace.automation.snapshot()
      if (!mounted.current) return
      setSnapshot(next)
      setError(null)
    } catch (reason) {
      if (!mounted.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) { setLoading(false); setRefreshing(false) }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    const timer = window.setInterval(() => void load(), 4000)
    return () => { mounted.current = false; window.clearInterval(timer) }
  }, [load])

  useEffect(() => {
    onStatusChange({
      online: !!snapshot?.online && !error,
      machineId: snapshot?.machineId,
      version: snapshot?.version,
      running: snapshot?.runs.filter((run) => ['queued', 'running', 'checking'].includes(run.status)).length ?? 0
    })
  }, [snapshot, error, onStatusChange])

  return <div className="auto-console" hidden={hidden}>
    {snapshot && (!snapshot.online || error) && <div className="auto-connection-banner" role="status">
      <span className="auto-connection-banner__dot" />
      <div><strong>{error ? 'Automation 서비스에 연결할 수 없습니다' : 'Automation 서비스가 오프라인입니다'}</strong><span>{error || '마지막으로 받은 상태를 표시합니다. 서비스 상태와 로컬 연결을 확인하세요.'}</span></div>
      <button className="auto-button" type="button" disabled={refreshing} onClick={() => void load(true)}>{refreshing ? <BusyLabel label="연결 중" /> : <><Icon name="refresh" /> 다시 연결</>}</button>
    </div>}

    {!snapshot && loading ? <ConsoleLoading /> : !snapshot ? <div className="auto-fatal-state" role="alert">
      <div className="auto-fatal-state__icon"><Icon name="machine" size={24} /></div>
      <h1>Automation 서비스에 연결할 수 없습니다</h1>
      <p>{error || '응답을 기다리는 동안 문제가 발생했습니다.'}</p>
      <button className="auto-button auto-button--primary" type="button" disabled={refreshing} onClick={() => void load(true)}>{refreshing ? <BusyLabel label="다시 연결 중" /> : <><Icon name="refresh" /> 다시 시도</>}</button>
    </div> : <>
      <div className="auto-section" hidden={section !== 'automations'}><AutomationsView snapshot={snapshot} onSnapshot={setSnapshot} showToast={showToast} /></div>
      <div className="auto-section" hidden={section !== 'runs'}><RunsView snapshot={snapshot} active={!hidden && section === 'runs'} showToast={showToast} /></div>
      <div className="auto-section" hidden={section !== 'sync'}><OmpSyncView snapshot={snapshot} onSnapshot={setSnapshot} showToast={showToast} /></div>
      <div className="auto-section" hidden={section !== 'machine'}><MachineView snapshot={snapshot} onSnapshot={setSnapshot} showToast={showToast} /></div>
    </>}
  </div>
}

function ConsoleLoading(): JSX.Element {
  return <div className="auto-page" aria-busy="true" aria-label="Automation 콘솔을 불러오는 중">
    <div className="auto-skeleton auto-skeleton--eyebrow" />
    <div className="auto-skeleton auto-skeleton--title" />
    <div className="auto-skeleton auto-skeleton--copy" />
    <div className="auto-summary-strip auto-skeleton-group"><div /><div /><div /><div /></div>
    <div className="auto-card-grid auto-skeleton-group"><article /><article /><article /></div>
  </div>
}
