import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AutomationRun, AutomationSnapshot, LoopDefinition, MachineSettings, RunDetail, RunLog, Trigger } from '../../shared/automation'
import type { CmuxKey, CmuxSurface, CompanionSnapshot } from '../../shared/companion'
import { ApiError, CompanionApi } from './api'
import { SkillsView } from './SkillsView'

const TOKEN_KEY = 'cmux-omp-pairing-token'
const ACTIVE_STATUS: Partial<Record<AutomationRun['status'], true>> = { queued: true, running: true, checking: true }
const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const TIMEZONES = [LOCAL_TIMEZONE, 'Asia/Seoul', 'UTC', 'America/Los_Angeles', 'America/New_York', 'Europe/London'].filter((item, index, all) => all.indexOf(item) === index)

type Tab = 'sessions' | 'loops' | 'skills'
type AutomationView = 'loops' | 'runs'
type ConnectionError = { message: string; status: number }

function consumePairingToken(): string {
  const hash = new URLSearchParams(window.location.hash.slice(1))
  const incoming = hash.get('token')?.trim()
  if (incoming) sessionStorage.setItem(TOKEN_KEY, incoming)
  if (hash.has('token')) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
  return incoming || sessionStorage.getItem(TOKEN_KEY) || ''
}

function errorInfo(reason: unknown): ConnectionError {
  return { message: reason instanceof Error ? reason.message : String(reason), status: reason instanceof ApiError ? reason.status : 0 }
}

function replaceAutomation(current: CompanionSnapshot, automation: AutomationSnapshot): CompanionSnapshot {
  return { ...current, automation }
}

export function App(): JSX.Element {
  const [token, setToken] = useState(consumePairingToken)
  const tokenRef = useRef(token)
  tokenRef.current = token
  const api = useMemo(() => new CompanionApi(() => tokenRef.current), [])
  const [snapshot, setSnapshot] = useState<CompanionSnapshot | null>(null)
  const [connectionError, setConnectionError] = useState<ConnectionError | null>(null)
  const [loading, setLoading] = useState(Boolean(token))
  const [tab, setTab] = useState<Tab>('sessions')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [toast, setToast] = useState('')
  const requestVersion = useRef(0)
  const loadingSnapshot = useRef(false)

  useEffect(() => { window.scrollTo({ top: 0 }) }, [tab])

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => setToast((current) => current === message ? '' : current), 2600)
  }, [])

  const loadSnapshot = useCallback(async () => {
    if (!tokenRef.current || loadingSnapshot.current) return
    const version = requestVersion.current
    loadingSnapshot.current = true
    try {
      const next = await api.snapshot()
      if (version !== requestVersion.current) return
      setSnapshot(next)
      setConnectionError(null)
    } catch (reason) {
      if (version === requestVersion.current) setConnectionError(errorInfo(reason))
    } finally {
      if (version === requestVersion.current) setLoading(false)
      loadingSnapshot.current = false
    }
  }, [api])

  useEffect(() => {
    if (!token) return
    setLoading(true)
    void loadSnapshot()
    let timer: number | undefined
    const syncTimer = (): void => {
      if (timer) window.clearInterval(timer)
      timer = undefined
      if (document.visibilityState === 'visible') {
        void loadSnapshot()
        timer = window.setInterval(() => void loadSnapshot(), 4_000)
      }
    }
    document.addEventListener('visibilitychange', syncTimer)
    syncTimer()
    return () => {
      document.removeEventListener('visibilitychange', syncTimer)
      if (timer) window.clearInterval(timer)
    }
  }, [token, loadSnapshot])

  const pair = useCallback((nextToken: string): void => {
    const clean = nextToken.trim()
    if (!clean) return
    requestVersion.current += 1
    tokenRef.current = clean
    sessionStorage.setItem(TOKEN_KEY, clean)
    setToken(clean)
    setSnapshot(null)
    setConnectionError(null)
    setLoading(true)
    void loadSnapshot()
  }, [loadSnapshot])

  useEffect(() => {
    const onHashChange = (): void => {
      if (new URLSearchParams(window.location.hash.slice(1)).has('token')) pair(consumePairingToken())
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [pair])

  const logout = (): void => {
    requestVersion.current += 1
    sessionStorage.removeItem(TOKEN_KEY)
    tokenRef.current = ''
    setToken('')
    setSnapshot(null)
    setConnectionError(null)
    setSettingsOpen(false)
  }

  const updateAutomation = useCallback((next: AutomationSnapshot) => {
    setSnapshot((current) => current ? replaceAutomation(current, next) : current)
  }, [])

  if (!token || (!snapshot && connectionError?.status === 401)) {
    return <PairingScreen onPair={pair} error={connectionError?.message} hasStoredToken={Boolean(token)} onForget={logout} />
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">›_</span><div><strong>cmux · OMP</strong><span>{snapshot?.automation.machineId || 'companion'}</span></div></div>
      <div className="top-actions">
        <span className={`connection-dot ${snapshot && !connectionError && snapshot.automation.online ? 'is-online' : ''}`} aria-label={connectionError ? '연결 오류' : '연결됨'} />
        <button className="icon-button" type="button" aria-label="설정 열기" onClick={() => setSettingsOpen(true)}><Icon name="settings" /></button>
      </div>
    </header>

    {connectionError && <ConnectionBanner error={connectionError} onRetry={() => void loadSnapshot()} onLogout={logout} />}
    {!connectionError && snapshot && !snapshot.automation.online && <ConnectionBanner error={{ status: 0, message: 'Automation 서비스가 오프라인입니다. 마지막으로 받은 상태를 표시합니다.' }} onRetry={() => void loadSnapshot()} onLogout={logout} />}

    <main className="main-content">
      {!snapshot && loading ? <LoadingState /> : snapshot ? <>
        <div hidden={tab !== 'sessions'}><SessionsView api={api} snapshot={snapshot} active={tab === 'sessions'} showToast={showToast} /></div>
        <div hidden={tab !== 'loops'}><AutomationsView api={api} snapshot={snapshot.automation} active={tab === 'loops'} onSnapshot={updateAutomation} showToast={showToast} onOpenSettings={() => setSettingsOpen(true)} /></div>
        <div hidden={tab !== 'skills'}><SkillsView api={api} active={tab === 'skills'} showToast={showToast} /></div>
      </> : <EmptyState title="서버 응답이 없습니다" description={connectionError?.message || '연결을 다시 시도하세요.'} action={<button className="button primary" type="button" onClick={() => void loadSnapshot()}>다시 시도</button>} />}
    </main>

    <nav className="tabbar" aria-label="주요 화면">
      <button type="button" className={tab === 'sessions' ? 'is-active' : ''} aria-current={tab === 'sessions' ? 'page' : undefined} onClick={() => setTab('sessions')}><Icon name="terminal" /><span>Sessions</span></button>
      <button type="button" className={tab === 'loops' ? 'is-active' : ''} aria-current={tab === 'loops' ? 'page' : undefined} onClick={() => setTab('loops')}><Icon name="automation" /><span><strong>Loops</strong><small>자동화</small></span></button>
      <button type="button" className={tab === 'skills' ? 'is-active' : ''} aria-current={tab === 'skills' ? 'page' : undefined} onClick={() => setTab('skills')}><Icon name="skills" /><span>Skills</span></button>
    </nav>

    {settingsOpen && snapshot && <SettingsSheet api={api} snapshot={snapshot.automation} onSnapshot={updateAutomation} onClose={() => setSettingsOpen(false)} onLogout={logout} showToast={showToast} />}
    {toast && <div className="toast" role="status">{toast}</div>}
  </div>
}

function PairingScreen({ onPair, error, hasStoredToken, onForget }: { onPair: (token: string) => void; error?: string; hasStoredToken: boolean; onForget: () => void }): JSX.Element {
  const [draft, setDraft] = useState('')
  const submit = (): void => { if (draft.trim()) onPair(draft) }
  return <main className="pairing">
    <div className="pairing-mark">›_</div>
    <p className="eyebrow">MOBILE COMPANION</p>
    <h1>cmux · OMP</h1>
    <p>Mac에서 <code>npm run companion:pair</code>로 발급한 페어링 링크나 토큰으로 연결하세요.</p>
    {error && <InlineError>{error}</InlineError>}
    <label className="field"><span>페어링 토큰</span><input type="password" autoComplete="off" autoCapitalize="none" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') submit() }} placeholder="토큰 붙여넣기" /></label>
    <button className="button primary full" type="button" disabled={!draft.trim()} onClick={submit}>연결</button>
    <p className="privacy-note">토큰은 이 탭의 sessionStorage에만 저장되며 URL에서는 즉시 삭제됩니다.</p>
    {hasStoredToken && <button className="text-button" type="button" onClick={onForget}>저장된 토큰 지우기</button>}
  </main>
}

function ConnectionBanner({ error, onRetry, onLogout }: { error: ConnectionError; onRetry: () => void; onLogout: () => void }): JSX.Element {
  return <div className={`connection-banner ${error.status === 401 ? 'danger' : ''}`} role="alert">
    <div><strong>{error.status === 401 ? '인증 실패' : '연결 끊김'}</strong><span>{error.message}</span></div>
    <div><button type="button" onClick={onRetry}>재시도</button>{error.status === 401 && <button type="button" onClick={onLogout}>다시 페어링</button>}</div>
  </div>
}

function LoadingState(): JSX.Element {
  return <div className="loading-state" aria-busy="true"><span className="spinner" /><strong>companion 연결 중</strong><span>cmux와 OMP 상태를 불러옵니다.</span></div>
}

function SessionsView({ api, snapshot, active, showToast }: { api: CompanionApi; snapshot: CompanionSnapshot; active: boolean; showToast: (message: string) => void }): JSX.Element {
  const surfaces = snapshot.cmux.surfaces
  const [selectedKey, setSelectedKey] = useState('')
  const [screen, setScreen] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [confirmInterrupt, setConfirmInterrupt] = useState<CmuxSurface | null>(null)
  const targetVersion = useRef(0)
  const reading = useRef(false)

  useEffect(() => {
    if (selectedKey && surfaces.some((surface) => surfaceKey(surface) === selectedKey)) return
    targetVersion.current += 1
    setSelectedKey(surfaces[0] ? surfaceKey(surfaces[0]) : '')
    setScreen('')
    setDraft('')
    setError(null)
  }, [surfaces, selectedKey])

  const selected = surfaces.find((surface) => surfaceKey(surface) === selectedKey) || null
  const pasteError = /[\u0000-\u001f\u007f]/.test(draft)
    ? '붙여넣기는 한 줄 텍스트만 지원합니다. 줄바꿈과 Tab은 아래의 전용 키로 따로 보내세요.'
    : ''
  const choose = (key: string): void => {
    targetVersion.current += 1
    setSelectedKey(key)
    setScreen('')
    setDraft('')
    setError(null)
  }

  const readScreen = useCallback(async () => {
    if (!selected || reading.current) return
    const version = targetVersion.current
    const key = surfaceKey(selected)
    reading.current = true
    try {
      const result = await api.readSurface(selected.workspaceId, selected.surfaceId)
      if (version === targetVersion.current && key === selectedKey) {
        setScreen(result.text)
        setError(null)
      }
    } catch (reason) {
      if (version === targetVersion.current && key === selectedKey) setError(errorInfo(reason).message)
    } finally {
      reading.current = false
    }
  }, [api, selected, selectedKey])

  useEffect(() => {
    if (!active || !selected) return
    let timer: number | undefined
    const syncPolling = (): void => {
      if (timer) window.clearInterval(timer)
      timer = undefined
      if (document.visibilityState === 'visible') {
        void readScreen()
        timer = window.setInterval(() => void readScreen(), 1_500)
      }
    }
    document.addEventListener('visibilitychange', syncPolling)
    syncPolling()
    return () => {
      document.removeEventListener('visibilitychange', syncPolling)
      if (timer) window.clearInterval(timer)
    }
  }, [active, selectedKey, readScreen, selected])

  const sendPaste = async (): Promise<void> => {
    if (!selected || !draft || pasteError) return
    const target = selected
    const version = targetVersion.current
    setSending(true); setError(null)
    try {
      await api.sendSurface(target.workspaceId, target.surfaceId, draft)
      if (version === targetVersion.current) setDraft('')
      showToast(`${target.workspaceName} · ${target.title}에 붙여넣었습니다`)
    } catch (reason) {
      if (version === targetVersion.current) setError(errorInfo(reason).message)
    } finally { setSending(false) }
  }

  const sendKey = async (key: CmuxKey, requestedTarget: CmuxSurface | null = selected): Promise<void> => {
    if (!requestedTarget) return
    const version = targetVersion.current
    setSending(true); setError(null)
    try {
      await api.keySurface(requestedTarget.workspaceId, requestedTarget.surfaceId, key)
      setConfirmInterrupt(null)
    } catch (reason) {
      if (version === targetVersion.current) setError(errorInfo(reason).message)
    } finally { setSending(false) }
  }

  return <section className="page sessions-page" aria-labelledby="sessions-title">
    <header className="page-header"><div><p className="eyebrow">CMUX</p><h1 id="sessions-title">Sessions</h1><p>실제 cmux surface를 확인하고 선택한 대상에만 입력합니다.</p></div><span className={`status-chip ${snapshot.cmux.available ? 'good' : 'bad'}`}>{snapshot.cmux.available ? `${surfaces.length}개 연결` : '사용 불가'}</span></header>
    {snapshot.cmux.error && <InlineError>{snapshot.cmux.error}</InlineError>}
    {error && <InlineError>{error}</InlineError>}
    {!snapshot.cmux.available ? <EmptyState title="cmux에 연결할 수 없습니다" description="Mac에서 cmux가 실행 중인지 확인한 뒤 다시 연결하세요." /> : surfaces.length === 0 ? <EmptyState title="열린 세션이 없습니다" description="Mac의 cmux에서 workspace와 terminal surface를 여세요." /> : <>
      <label className="field target-field"><span>입력 대상</span><select value={selectedKey} disabled={sending} onChange={(event) => choose(event.target.value)}>{surfaces.map((surface) => <option key={surfaceKey(surface)} value={surfaceKey(surface)}>{surface.workspaceName} · {surface.title}</option>)}</select><small>{selected ? `workspace ${selected.workspaceId} · surface ${selected.surfaceId}` : '대상을 선택하세요.'}</small></label>
      <div className="terminal-card">
        <div className="terminal-head"><span className="live-dot" /> <strong>{selected ? `${selected.workspaceName} / ${selected.title}` : '선택 없음'}</strong><button type="button" className="text-button" onClick={() => void readScreen()}>새로고침</button></div>
        <pre className="screen" aria-label="선택한 cmux 화면" tabIndex={0}>{screen || '화면 내용을 기다리는 중…'}</pre>
      </div>
      <div className="composer">
        <label className="field"><span>한 줄 텍스트 붙여넣기</span><textarea rows={3} value={draft} onChange={(event) => setDraft(event.target.value)} aria-describedby={pasteError ? 'paste-error' : 'paste-help'} placeholder="전송해도 Enter는 자동 입력되지 않습니다." /><small id="paste-help">명령 실행은 아래 Enter 키를 별도로 눌러야 합니다.</small></label>
        {pasteError && <p className="field-error" id="paste-error" role="alert">{pasteError}</p>}
        <button type="button" className="button primary full" disabled={!selected || !draft || Boolean(pasteError) || sending} onClick={() => void sendPaste()}>{sending ? '전송 중…' : '선택한 대상에 붙여넣기'}</button>
      </div>
      <div className="keypad" aria-label="터미널 키">
        {(['Enter', 'Escape', 'Up', 'Down', 'Tab'] as CmuxKey[]).map((key) => <button type="button" key={key} disabled={!selected || sending} onClick={() => void sendKey(key)}>{key === 'Up' ? '↑' : key === 'Down' ? '↓' : key}</button>)}
        <button type="button" className="danger-ghost" disabled={!selected || sending} onClick={() => setConfirmInterrupt(selected)}>Ctrl+C</button>
      </div>
    </>}
    {confirmInterrupt && <ConfirmModal title="실행을 중단할까요?" description={`${confirmInterrupt.workspaceName} · ${confirmInterrupt.title}에 Ctrl+C를 보냅니다.`} confirmLabel="Ctrl+C 보내기" danger onCancel={() => setConfirmInterrupt(null)} onConfirm={() => void sendKey('Ctrl+C', confirmInterrupt)} busy={sending} />}
  </section>
}

function AutomationsView({ api, snapshot, active, onSnapshot, showToast, onOpenSettings }: { api: CompanionApi; snapshot: AutomationSnapshot; active: boolean; onSnapshot: (snapshot: AutomationSnapshot) => void; showToast: (message: string) => void; onOpenSettings: () => void }): JSX.Element {
  const [view, setView] = useState<AutomationView>('loops')
  const [editing, setEditing] = useState<{ loop: LoopDefinition; isNew: boolean } | null>(null)
  const [approveTarget, setApproveTarget] = useState<LoopDefinition | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LoopDefinition | null>(null)
  const [selectedRunId, setSelectedRunId] = useState('')
  const [optimisticRun, setOptimisticRun] = useState<AutomationRun | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)
  const loops = snapshot.profile.loops
  const projects = Object.keys(snapshot.settings.projectPaths)
  const historyRuns = useMemo(() => optimisticRun && !snapshot.runs.some((run) => run.id === optimisticRun.id) ? [optimisticRun, ...snapshot.runs] : snapshot.runs, [optimisticRun, snapshot.runs])
  const runSummary = useMemo(() => {
    const result = new Map<string, { latest: AutomationRun; active?: AutomationRun }>()
    for (const run of historyRuns) {
      const current = result.get(run.loopId)
      if (!current) {
        result.set(run.loopId, { latest: run, active: ACTIVE_STATUS[run.status] ? run : undefined })
        continue
      }
      if (run.createdAt > current.latest.createdAt) current.latest = run
      if (ACTIVE_STATUS[run.status] && (!current.active || run.createdAt > current.active.createdAt)) current.active = run
    }
    return result
  }, [historyRuns])

  useEffect(() => {
    if (optimisticRun && snapshot.runs.some((run) => run.id === optimisticRun.id)) setOptimisticRun(null)
  }, [optimisticRun, snapshot.runs])

  const action = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await fn()
    } catch (reason) {
      setError(errorInfo(reason).message)
    } finally {
      setBusy('')
    }
  }

  const toggleArmed = (): void => {
    void action('armed', async () => {
      const next = await api.saveSettings({ ...snapshot.settings, armed: !snapshot.settings.armed })
      onSnapshot(next)
      showToast(next.settings.armed ? '예약 실행을 준비했습니다' : '예약 실행 전체를 일시정지했습니다')
    })
  }

  const toggleLoop = (loop: LoopDefinition): void => {
    void action(`toggle:${loop.id}`, async () => {
      const next = await api.saveLoop({ ...loop, enabled: !loop.enabled })
      onSnapshot(next)
      showToast(loop.enabled ? '이 Loop를 일시정지했습니다' : 'Loop를 켰습니다. 다음 단계로 실행을 승인하세요.')
    })
  }

  const openHistory = (runId: string): void => {
    setSelectedRunId(runId)
    setView('runs')
  }

  const startRun = (loop: LoopDefinition): void => {
    void action(`run:${loop.id}`, async () => {
      const run = await api.runLoop(loop.id)
      setOptimisticRun(run)
      openHistory(run.id)
      showToast('실행을 시작하고 기록을 열었습니다')
    })
  }

  return <section className="page automations-page" aria-labelledby="automations-title">
    <header className="page-header"><div><p className="eyebrow">자동화</p><h1 id="automations-title">Loops</h1><p>미션을 수행하고 검사한 뒤, 실패하면 정해진 범위 안에서 다시 시도합니다.</p></div><button className={`armed-button ${snapshot.settings.armed ? 'is-armed' : ''}`} type="button" disabled={Boolean(busy)} aria-pressed={snapshot.settings.armed} onClick={toggleArmed}><span />{snapshot.settings.armed ? '예약 준비됨' : '예약 일시정지'}</button></header>
    <div className="segmented" role="tablist" aria-label="Loops 보기"><button role="tab" aria-selected={view === 'loops'} className={view === 'loops' ? 'is-active' : ''} onClick={() => setView('loops')}>Loops {loops.length}</button><button role="tab" aria-selected={view === 'runs'} className={view === 'runs' ? 'is-active' : ''} onClick={() => setView('runs')}>실행 기록 {snapshot.runs.length}</button></div>
    {error && <InlineError>{error}</InlineError>}
    {snapshot.schedulerError && <InlineError>스케줄러: {snapshot.schedulerError}</InlineError>}
    {view === 'loops' ? <>
      <div className="section-actions"><span>{loops.filter((loop) => loop.enabled).length}개 활성 · {loops.filter((loop) => snapshot.approved[loop.id]).length}개 승인</span><button className="button primary" type="button" disabled={!projects.length} onClick={() => setEditing({ loop: newLoop(projects[0] || ''), isNew: true })}>새 Loop</button></div>
      {loops.length === 0 ? <div className="loop-empty"><span className="empty-mark">↻</span><h2>첫 Loop를 만들어 보세요</h2><p>반복 작업을 <strong>미션 → 검사 → 실패 시 재시도</strong> 흐름으로 자동화합니다.</p><ol><li><b>1</b><span><strong>미션과 검사</strong><small>해야 할 일과 성공을 확인할 명령을 정합니다.</small></span></li><li><b>2</b><span><strong>일정과 한도</strong><small>수동 또는 예약 실행, 최대 시도와 시간을 정합니다.</small></span></li><li><b>3</b><span><strong>저장 후 승인</strong><small>새 Loop는 활성 상태로 저장되지만 자동 승인·예약 준비는 하지 않습니다.</small></span></li></ol><button className="button primary" type="button" disabled={!projects.length} onClick={() => setEditing({ loop: newLoop(projects[0] || ''), isNew: true })}>첫 Loop 만들기</button></div> : <div className="card-list">{loops.map((loop) => {
        const approved = Boolean(snapshot.approved[loop.id])
        const schedule = snapshot.schedules?.[`${loop.trigger.kind}:${loop.id}`]
        const scheduleError = snapshot.schedulerErrors?.[loop.id]
        const summary = runSummary.get(loop.id)
        const running = Boolean(summary?.active)
        const nextRun = !loop.enabled ? '이 Loop가 일시정지되어 실행하지 않습니다.' : !approved ? '실행 승인이 없어 시작하지 않습니다.' : !snapshot.settings.armed && loop.trigger.kind !== 'manual' && loop.trigger.kind !== 'webhook' ? '예약 실행 전체가 일시정지되어 있습니다.' : (scheduleError || snapshot.schedulerError) && loop.trigger.kind !== 'manual' && loop.trigger.kind !== 'webhook' ? '스케줄 오류를 먼저 해결해야 합니다.' : schedule ? formatDate(schedule) : loop.trigger.kind === 'manual' || loop.trigger.kind === 'webhook' ? '예약 없음 · 필요할 때 직접 실행' : '다음 일정을 계산하는 중'
        return <article className="loop-card" key={loop.id}>
          <div className="card-heading"><div><div className="title-row"><h2>{loop.name}</h2>{running && <span className="live-badge">실행 중</span>}</div><span className="mono muted">{loop.id}</span></div><button className="icon-button" type="button" aria-label={`${loop.name} 편집`} onClick={() => setEditing({ loop, isNew: false })}><Icon name="edit" /></button></div>
          <p className="mission">{loop.mission}</p>
          <div className="loop-facts"><span><b>프로젝트</b>{loop.project}</span><span><b>일정</b>{triggerLabel(loop.trigger)}</span><span><b>시도 한도</b>최대 {loop.maxAttempts}회</span><span><b>전체 실행 시간</b>모든 시도와 검사 포함 {loop.timeoutMinutes}분</span></div>
          <div className={`next-run-panel ${!loop.enabled || !approved || (!snapshot.settings.armed && loop.trigger.kind !== 'manual' && loop.trigger.kind !== 'webhook') || Boolean((scheduleError || snapshot.schedulerError) && loop.trigger.kind !== 'manual' && loop.trigger.kind !== 'webhook') ? 'is-paused' : ''}`}><span>다음 실행</span><strong>{nextRun}</strong></div>
          {scheduleError && <p className="field-error">스케줄 오류: {scheduleError}</p>}
          <div className="state-row"><span className={`status-chip ${approved ? 'good' : 'warn'}`}>{approved ? '실행 승인됨' : '승인 필요'}</span><span className={`status-chip ${loop.enabled ? 'good' : ''}`}>{loop.enabled ? 'Loop 활성' : '개별 일시정지'}</span></div>
          {summary?.latest && <button className="latest-outcome" type="button" onClick={() => openHistory(summary.latest.id)}><span><b>최근 결과</b><strong className={statusTone(summary.latest.status)}>{statusLabel(summary.latest.status)}</strong><small>{formatDate(summary.latest.finishedAt || summary.latest.startedAt || summary.latest.createdAt)}</small></span><span>기록 보기 ›</span></button>}
          <div className="card-actions">{loop.enabled && approved && !running && <button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => startRun(loop)}>지금 실행</button>}<button className="button" type="button" disabled={Boolean(busy)} onClick={() => toggleLoop(loop)}>{loop.enabled ? 'Loop 일시정지' : 'Loop 켜기'}</button>{loop.enabled && !approved && <button className="button approve-action" type="button" disabled={Boolean(busy)} onClick={() => setApproveTarget(loop)}>다음 단계 · 실행 승인</button>}{summary?.active && <button className="button approve-action" type="button" onClick={() => openHistory(summary.active!.id)}>실행 기록 열기</button>}</div>
        </article>
      })}</div>}
    </> : <RunHistory api={api} runs={historyRuns} active={active && view === 'runs'} selectedId={selectedRunId} onSelect={setSelectedRunId} showToast={showToast} />}

    {editing && <LoopEditor initial={editing.loop} isNew={editing.isNew} projects={projects} busy={busy === `save:${editing.loop.id}`} onClose={() => setEditing(null)} onDelete={editing.isNew ? undefined : () => { setDeleteTarget(editing.loop); setEditing(null) }} onSave={(loop) => void action(`save:${editing.loop.id}`, async () => { const next = await api.saveLoop(loop); onSnapshot(next); setEditing(null); if (loop.enabled) { setApproveTarget(loop); showToast('저장했습니다. 다음 단계로 실행 승인 내용을 확인하세요.') } else showToast('저장했습니다. 이 Loop는 개별 일시정지 상태입니다.') })} />}
    {approveTarget && <ConfirmModal title="이 머신에서 실행 승인" description={`${approveTarget.name}이(가) ${snapshot.settings.projectPaths[approveTarget.project] || approveTarget.project}의 코드를 읽고 수정하며 명령을 실행할 수 있습니다. 이 승인은 예약 실행 전체를 준비(Armed)하지 않습니다.`} confirmLabel="이 Loop 실행 승인" danger busy={busy === `approve:${approveTarget.id}`} onCancel={() => setApproveTarget(null)} onConfirm={() => void action(`approve:${approveTarget.id}`, async () => { const next = await api.approveLoop(approveTarget.id); onSnapshot(next); setApproveTarget(null); showToast(snapshot.settings.armed ? '실행을 승인했습니다' : '승인했습니다. 예약 실행은 아직 전체 일시정지 상태입니다.') })} />}
    {deleteTarget && <ConfirmModal title="Loop를 삭제할까요?" description={`${deleteTarget.name} 정의를 삭제합니다. 기존 실행 기록은 남을 수 있습니다.`} confirmLabel="삭제" danger busy={busy === `delete:${deleteTarget.id}`} onCancel={() => setDeleteTarget(null)} onConfirm={() => void action(`delete:${deleteTarget.id}`, async () => { const next = await api.deleteLoop(deleteTarget.id); onSnapshot(next); setDeleteTarget(null); showToast('Loop를 삭제했습니다') })} />}
    {!projects.length && view === 'loops' && <button className="settings-nudge" type="button" onClick={onOpenSettings}>Loop를 만들려면 설정에서 프로젝트 경로를 먼저 추가하세요 →</button>}
  </section>
}

function newLoop(project: string): LoopDefinition {
  return { id: `loop-${Date.now().toString(36)}`, name: '', project, mission: '', model: 'auto', trigger: { kind: 'manual' }, checks: [], maxAttempts: 3, timeoutMinutes: 30, enabled: true }
}

function LoopEditor({ initial, isNew, projects, busy, onClose, onSave, onDelete }: { initial: LoopDefinition; isNew: boolean; projects: string[]; busy: boolean; onClose: () => void; onSave: (loop: LoopDefinition) => void; onDelete?: () => void }): JSX.Element {
  const [draft, setDraft] = useState<LoopDefinition>(() => structuredClone(initial))
  const [checks, setChecks] = useState(initial.checks.join('\n'))
  const [formError, setFormError] = useState('')
  const unsupportedTrigger = draft.trigger.kind === 'github' || draft.trigger.kind === 'webhook'
  const trigger = draft.trigger
  const update = <K extends keyof LoopDefinition>(key: K, value: LoopDefinition[K]): void => setDraft((current) => ({ ...current, [key]: value }))

  const setTriggerKind = (kind: 'manual' | 'interval' | 'daily' | 'cron'): void => {
    const nextTrigger: Trigger = kind === 'manual' ? { kind } : kind === 'interval' ? { kind, seconds: 300 } : kind === 'daily' ? { kind, time: '09:00', timezone: LOCAL_TIMEZONE } : { kind, expression: '0 9 * * 1-5', timezone: LOCAL_TIMEZONE }
    update('trigger', nextTrigger)
  }

  const submit = (): void => {
    if (![draft.id, draft.name, draft.project, draft.mission, draft.model].every((value) => value.trim())) return setFormError('이름, 프로젝트, 미션, 모델을 모두 입력하세요.')
    if (!projects.includes(draft.project)) return setFormError('설정에 등록된 프로젝트를 선택하세요.')
    if (!Number.isInteger(draft.maxAttempts) || draft.maxAttempts < 1 || draft.maxAttempts > 20) return setFormError('최대 시도는 1~20의 정수여야 합니다.')
    if (!Number.isInteger(draft.timeoutMinutes) || draft.timeoutMinutes < 1 || draft.timeoutMinutes > 1440) return setFormError('전체 제한 시간은 1~1440분의 정수여야 합니다.')
    if (draft.trigger.kind === 'interval' && (!Number.isInteger(draft.trigger.seconds) || draft.trigger.seconds < 10)) return setFormError('반복 간격은 10초 이상의 정수여야 합니다.')
    if (draft.trigger.kind === 'daily' && (!draft.trigger.time || !validTimezone(draft.trigger.timezone))) return setFormError('시간과 유효한 IANA 시간대를 입력하세요.')
    if (draft.trigger.kind === 'cron' && (!draft.trigger.expression.trim() || !validTimezone(draft.trigger.timezone))) return setFormError('Cron 표현식과 유효한 IANA 시간대를 입력하세요.')
    onSave({ ...draft, id: draft.id.trim(), name: draft.name.trim(), project: draft.project, mission: draft.mission.trim(), model: draft.model.trim(), checks: checks.split('\n').map((line) => line.trim()).filter(Boolean) })
  }

  return <Modal title={isNew ? '새 Loop 만들기' : 'Loop 편집'} subtitle={isNew ? '저장 후 실행 승인을 확인하면 준비가 끝납니다.' : '내용이나 활성 상태를 저장하면 실행 승인이 해제됩니다.'} onClose={onClose} footer={<><div>{onDelete && <button className="button danger-ghost" type="button" onClick={onDelete}>삭제</button>}</div><div><button className="button" type="button" onClick={onClose}>취소</button><button className="button primary" type="button" disabled={busy || !projects.length} onClick={submit}>{busy ? '저장 중…' : isNew ? '저장하고 승인으로' : '변경 저장'}</button></div></>}>
    <div className="form-stack">
      {isNew && <div className="loop-flow"><span><b>1</b>미션</span><i>→</i><span><b>2</b>검사</span><i>→</i><span><b>3</b>재시도</span></div>}
      <label className="field"><span>이름</span><input autoFocus value={draft.name} onChange={(event) => update('name', event.target.value)} placeholder="예: 매일 의존성 상태 확인" /></label>
      <label className="field"><span>등록된 프로젝트</span><select value={draft.project} disabled={!projects.length} onChange={(event) => update('project', event.target.value)}><option value="">프로젝트 선택</option>{projects.map((project) => <option value={project} key={project}>{project}</option>)}</select><small>잘못된 경로 입력을 막기 위해 설정에 등록된 프로젝트만 선택할 수 있습니다.</small></label>
      <label className="field"><span>미션</span><textarea rows={5} value={draft.mission} onChange={(event) => update('mission', event.target.value)} placeholder="해야 할 일, 변경 범위, 완료 조건을 구체적으로 작성하세요." /><small>OMP가 각 시도에서 수행할 목표입니다.</small></label>
      <label className="field"><span>검사 명령 · 한 줄에 하나</span><textarea className="mono" rows={4} value={checks} onChange={(event) => setChecks(event.target.value)} placeholder="npm test&#10;npm run typecheck" /><small>검사가 실패하면 최대 시도 횟수 안에서 다시 수행합니다. 검사가 없으면 검토 필요로 끝날 수 있습니다.</small></label>
      <label className="field"><span>실행 일정</span><select value={draft.trigger.kind} disabled={unsupportedTrigger} onChange={(event) => setTriggerKind(event.target.value as 'manual' | 'interval' | 'daily' | 'cron')}><option value="manual">수동 · 필요할 때 실행</option><option value="interval">일정 간격</option><option value="daily">매일</option><option value="cron">Cron</option>{unsupportedTrigger && <option value={draft.trigger.kind}>{draft.trigger.kind === 'github' ? 'GitHub (기존 설정)' : 'Webhook (기존 설정)'}</option>}</select></label>
      {unsupportedTrigger && <div className="notice"><strong>이 트리거는 모바일 편집을 지원하지 않습니다.</strong><span>다른 필드를 저장해도 기존 {draft.trigger.kind} 설정은 그대로 유지됩니다.</span></div>}
      {trigger.kind === 'interval' && <label className="field"><span>간격 (초)</span><input type="number" inputMode="numeric" min={10} value={trigger.seconds} onChange={(event) => update('trigger', { ...trigger, seconds: Number(event.target.value) })} /></label>}
      {trigger.kind === 'daily' && <><label className="field"><span>시간</span><input type="time" value={trigger.time} onChange={(event) => update('trigger', { ...trigger, time: event.target.value })} /></label><TimezoneField value={trigger.timezone} onChange={(timezone) => update('trigger', { ...trigger, timezone })} /></>}
      {trigger.kind === 'cron' && <><label className="field"><span>Cron 표현식</span><input className="mono" value={trigger.expression} onChange={(event) => update('trigger', { ...trigger, expression: event.target.value })} placeholder="0 9 * * 1-5" /></label><TimezoneField value={trigger.timezone} onChange={(timezone) => update('trigger', { ...trigger, timezone })} /></>}
      <div className="field-grid"><label className="field"><span>최대 시도</span><input type="number" inputMode="numeric" min={1} max={20} value={draft.maxAttempts} onChange={(event) => update('maxAttempts', Number(event.target.value))} /></label><label className="field"><span>전체 시간 제한 (분)</span><input type="number" inputMode="numeric" min={1} max={1440} value={draft.timeoutMinutes} onChange={(event) => update('timeoutMinutes', Number(event.target.value))} /></label></div>
      <div className="bounds-summary"><span>모든 재시도·검사 포함</span><strong>{Number.isFinite(draft.maxAttempts) && Number.isFinite(draft.timeoutMinutes) ? `최대 ${draft.maxAttempts}회 · 전체 ${draft.timeoutMinutes}분 이내` : '값을 확인하세요'}</strong></div>
      <label className="field"><span>모델</span><input value={draft.model} onChange={(event) => update('model', event.target.value)} placeholder="auto" /><small>auto는 실행 머신의 OMP 기본 모델을 사용합니다.</small></label>
      <label className="toggle-row"><input type="checkbox" checked={draft.enabled} onChange={(event) => update('enabled', event.target.checked)} /><span><strong>이 Loop 활성화</strong><small>새 Loop는 기본으로 활성화되지만 저장만으로 승인되거나 예약 전체가 준비되지는 않습니다.</small></span></label>
      <div className="approval-next"><strong>저장 다음 단계</strong><span>실행 승인 내용을 확인하세요. 예약 실행은 별도로 상단의 ‘예약 준비’를 켜야 하며 자동으로 켜지지 않습니다.</span></div>
      {formError && <InlineError>{formError}</InlineError>}
    </div>
  </Modal>
}

function TimezoneField({ value, onChange }: { value: string; onChange: (value: string) => void }): JSX.Element {
  return <label className="field"><span>IANA 시간대</span><input list="timezone-options" value={value} onChange={(event) => onChange(event.target.value)} placeholder="Asia/Seoul" /><datalist id="timezone-options">{TIMEZONES.map((timezone) => <option value={timezone} key={timezone} />)}</datalist></label>
}

function RunHistory({ api, runs, active, selectedId, onSelect, showToast }: { api: CompanionApi; runs: AutomationRun[]; active: boolean; selectedId: string; onSelect: (id: string) => void; showToast: (message: string) => void }): JSX.Element {
  const sorted = useMemo(() => [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [runs])
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const detailVersion = useRef(0)
  const latestSeq = useRef(0)
  const loading = useRef(false)
  const previousSelectedId = useRef('')

  useEffect(() => {
    if (previousSelectedId.current === selectedId) return
    previousSelectedId.current = selectedId
    detailVersion.current += 1
    latestSeq.current = 0
    setDetail(null)
    setError('')
  }, [selectedId])

  useEffect(() => {
    if (selectedId && sorted.some((run) => run.id === selectedId)) return
    onSelect(sorted[0]?.id || '')
  }, [sorted, selectedId, onSelect])


  const loadDetail = useCallback(async () => {
    if (!selectedId || loading.current) return
    const id = selectedId
    const version = detailVersion.current
    loading.current = true
    try {
      const next = await api.runDetail(id, latestSeq.current || undefined)
      if (version !== detailVersion.current || id !== selectedId) return
      setDetail((current) => {
        const logs = mergeLogs(current?.logs || [], next.logs)
        latestSeq.current = logs[logs.length - 1]?.seq || 0
        return { run: next.run, logs }
      })
      setError('')
    } catch (reason) {
      if (version === detailVersion.current && id === selectedId) setError(errorInfo(reason).message)
    } finally { loading.current = false }
  }, [api, selectedId])

  useEffect(() => {
    if (!active || !selectedId) return
    let timer: number | undefined
    const syncPolling = (): void => {
      if (timer) window.clearInterval(timer)
      timer = undefined
      if (document.visibilityState === 'visible') {
        void loadDetail()
        timer = window.setInterval(() => void loadDetail(), 1_500)
      }
    }
    document.addEventListener('visibilitychange', syncPolling)
    syncPolling()
    return () => {
      document.removeEventListener('visibilitychange', syncPolling)
      if (timer) window.clearInterval(timer)
    }
  }, [active, selectedId, loadDetail])

  const run = detail?.run || sorted.find((item) => item.id === selectedId) || null
  const activeRun = run ? Boolean(ACTIVE_STATUS[run.status]) : false
  const cancel = async (): Promise<void> => {
    if (!run) return
    setBusy('cancel'); setError('')
    try { await api.cancelRun(run.id); showToast('실행 취소를 요청했습니다'); void loadDetail() } catch (reason) { setError(errorInfo(reason).message) } finally { setBusy('') }
  }
  const open = async (): Promise<void> => {
    if (!run) return
    setBusy('open'); setError('')
    try { await api.openRun(run.id); showToast('완료된 실행을 cmux에서 열었습니다') } catch (reason) { setError(errorInfo(reason).message) } finally { setBusy('') }
  }

  if (!sorted.length) return <EmptyState title="실행 기록이 없습니다" description="활성화하고 승인한 Loop를 실행하면 상태와 로그가 여기에 표시됩니다." />
  return <div className="runs-view">
    <label className="field"><span>실행 선택</span><select value={selectedId} onChange={(event) => onSelect(event.target.value)}>{sorted.map((item) => <option key={item.id} value={item.id}>{item.loopName} · {statusLabel(item.status)} · {formatDate(item.createdAt)}</option>)}</select></label>
    {error && <InlineError>{error}</InlineError>}
    {run && <article className="run-detail">
      <div className="card-heading"><div><h2>{run.loopName}</h2><span className="mono muted">{run.id}</span></div><span className={`status-chip ${statusTone(run.status)}`}>{statusLabel(run.status)}</span></div>
      <div className="run-facts"><span><b>트리거</b>{run.trigger}</span><span><b>시도</b>{run.attempt}</span><span><b>시작</b>{formatDate(run.startedAt || run.createdAt)}</span><span><b>종료</b>{formatDate(run.finishedAt)}</span>{run.worktree && <span className="wide"><b>Worktree</b><span className="mono">{run.worktree}</span></span>}{run.branch && <span className="wide"><b>Branch</b><span className="mono">{run.branch}</span></span>}</div>
      {run.error && <div className="run-error"><strong>실행 오류</strong><pre>{run.error}</pre></div>}
      <div className="run-actions">{activeRun ? <button className="button danger-ghost" type="button" disabled={Boolean(busy)} onClick={() => void cancel()}>{busy === 'cancel' ? '취소 요청 중…' : '실행 취소'}</button> : <button className="button" type="button" disabled={Boolean(busy)} onClick={() => void open()}>{busy === 'open' ? '여는 중…' : 'cmux에서 열기'}</button>}</div>
      <div className="logs"><div className="logs-head"><strong>증분 로그</strong><span>{detail?.logs.length || 0} lines {activeRun && <b>LIVE</b>}</span></div><div className="log-body" role="log" aria-live="polite">{detail?.logs.length ? detail.logs.map((log) => <LogRow key={log.seq} log={log} />) : <p>아직 기록된 로그가 없습니다.</p>}</div></div>
    </article>}
  </div>
}

function LogRow({ log }: { log: RunLog }): JSX.Element {
  return <div className={`log-row ${log.kind}`}><div><time>{new Date(log.at).toLocaleTimeString('ko-KR', { hour12: false })}</time><span>{log.kind}</span></div><pre>{log.text}</pre></div>
}

function SettingsSheet({ api, snapshot, onSnapshot, onClose, onLogout, showToast }: { api: CompanionApi; snapshot: AutomationSnapshot; onSnapshot: (snapshot: AutomationSnapshot) => void; onClose: () => void; onLogout: () => void; showToast: (message: string) => void }): JSX.Element {
  const [draft, setDraft] = useState<MachineSettings>(() => structuredClone(snapshot.settings))
  const [paths, setPaths] = useState(() => Object.entries(snapshot.settings.projectPaths).map(([key, path]) => ({ key, path })))
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [confirmImport, setConfirmImport] = useState(false)

  const save = async (): Promise<void> => {
    setBusy('save'); setError('')
    try {
      const projectPaths: Record<string, string> = {}
      for (const item of paths) {
        const key = item.key.trim(); const path = item.path.trim()
        if (!key || !path) throw new Error('모든 프로젝트에 키와 절대 폴더 경로가 필요합니다.')
        if (!path.startsWith('/')) throw new Error(`${key} 경로는 /로 시작해야 합니다.`)
        if (projectPaths[key] !== undefined) throw new Error(`프로젝트 키가 중복됩니다: ${key}`)
        projectPaths[key] = path
      }
      if (!draft.ompCommand.trim()) throw new Error('OMP 실행 명령을 입력하세요.')
      if (!Number.isInteger(draft.maxConcurrentRuns) || draft.maxConcurrentRuns < 1 || draft.maxConcurrentRuns > 16) throw new Error('동시 실행 수는 1~16의 정수여야 합니다.')
      const next = await api.saveSettings({ ...snapshot.settings, projectPaths, ompCommand: draft.ompCommand.trim(), maxConcurrentRuns: draft.maxConcurrentRuns, armed: draft.armed })
      onSnapshot(next); showToast('머신 설정을 저장했습니다'); onClose()
    } catch (reason) { setError(errorInfo(reason).message) } finally { setBusy('') }
  }

  const importOmp = async (): Promise<void> => {
    setBusy('import'); setError('')
    try { const next = await api.importOmp(); onSnapshot(next); setConfirmImport(false); showToast('로컬 OMP 구성을 가져왔습니다') } catch (reason) { setError(errorInfo(reason).message) } finally { setBusy('') }
  }

  return <>
    <Modal title="설정 · 연결" subtitle={`${snapshot.machineId} · v${snapshot.version}`} onClose={onClose} footer={<><button className="button danger-ghost" type="button" onClick={onLogout}>로그아웃</button><div><button className="button" type="button" onClick={onClose}>취소</button><button className="button primary" type="button" disabled={Boolean(busy)} onClick={() => void save()}>{busy === 'save' ? '저장 중…' : '저장'}</button></div></>}>
      <div className="form-stack">
        <label className="toggle-row"><input type="checkbox" checked={draft.armed} onChange={(event) => setDraft((current) => ({ ...current, armed: event.target.checked }))} /><span><strong>전역 자동 실행 Armed</strong><small>끄면 모든 예약 실행을 멈춥니다.</small></span></label>
        <div className="field-title"><div><strong>프로젝트 경로</strong><small>자동화의 프로젝트 키를 절대 폴더에 연결합니다.</small></div><button className="text-button" type="button" onClick={() => setPaths((current) => [...current, { key: '', path: '' }])}>+ 추가</button></div>
        {paths.length === 0 && <div className="compact-empty">등록된 프로젝트가 없습니다.</div>}
        {paths.map((item, index) => <div className="path-row" key={index}><label className="field"><span>키</span><input value={item.key} onChange={(event) => setPaths((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, key: event.target.value } : row))} placeholder="my-project" /></label><label className="field"><span>절대 폴더</span><input className="mono" value={item.path} onChange={(event) => setPaths((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, path: event.target.value } : row))} placeholder="/Users/me/project" /></label><button className="icon-button remove-path" type="button" aria-label={`프로젝트 ${index + 1} 삭제`} onClick={() => setPaths((current) => current.filter((_, rowIndex) => rowIndex !== index))}><Icon name="trash" /></button></div>)}
        <label className="field"><span>OMP 명령</span><input className="mono" value={draft.ompCommand} onChange={(event) => setDraft((current) => ({ ...current, ompCommand: event.target.value }))} /></label>
        <label className="field"><span>최대 동시 실행</span><input type="number" inputMode="numeric" min={1} max={16} value={draft.maxConcurrentRuns} onChange={(event) => setDraft((current) => ({ ...current, maxConcurrentRuns: Number(event.target.value) }))} /></label>
        <div className="notice"><strong>숨은 동기화 설정은 유지됩니다.</strong><span>이 화면은 sync remote와 branch를 변경하지 않습니다.</span></div>
        <button className="button full" type="button" disabled={Boolean(busy)} onClick={() => setConfirmImport(true)}>로컬 OMP 구성 가져오기</button>
        {error && <InlineError>{error}</InlineError>}
      </div>
    </Modal>
    {confirmImport && <ConfirmModal title="로컬 OMP 구성을 가져올까요?" description="현재 머신의 OMP 설정, Instructions, Skills로 저장된 portable profile을 교체합니다." confirmLabel="가져오기" danger busy={busy === 'import'} onCancel={() => setConfirmImport(false)} onConfirm={() => void importOmp()} />}
  </>
}

function Modal({ title, subtitle, onClose, footer, children }: { title: string; subtitle?: string; onClose: () => void; footer: ReactNode; children: ReactNode }): JSX.Element {
  const titleId = useId()
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}><header><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" type="button" aria-label="닫기" onClick={onClose}>×</button></header><div className="modal-body">{children}</div><footer>{footer}</footer></section></div>
}

function ConfirmModal({ title, description, confirmLabel, danger, busy, onCancel, onConfirm }: { title: string; description: string; confirmLabel: string; danger?: boolean; busy?: boolean; onCancel: () => void; onConfirm: () => void }): JSX.Element {
  return <Modal title={title} subtitle={description} onClose={onCancel} footer={<><span /><div><button className="button" type="button" onClick={onCancel}>취소</button><button className={`button ${danger ? 'danger' : 'primary'}`} type="button" disabled={busy} onClick={onConfirm}>{busy ? '처리 중…' : confirmLabel}</button></div></>}><div className="warning-panel"><Icon name="warning" /><span>대상과 내용을 확인한 뒤 계속하세요.</span></div></Modal>
}

function InlineError({ children }: { children: ReactNode }): JSX.Element { return <div className="inline-error" role="alert"><Icon name="warning" /><span>{children}</span></div> }
function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }): JSX.Element { return <div className="empty-state"><span className="empty-mark">›_</span><strong>{title}</strong><p>{description}</p>{action}</div> }

function Icon({ name }: { name: 'settings' | 'terminal' | 'automation' | 'skills' | 'edit' | 'trash' | 'warning' }): JSX.Element {
  const paths: Record<typeof name, ReactNode> = {
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m5 0h5" /></>,
    automation: <><path d="M8 6h8M8 12h8M8 18h8" /><circle cx="5" cy="6" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="18" r="1" /></>,
    skills: <><path d="M9 4.5a3 3 0 1 1 6 0V9h4.5a3 3 0 1 1 0 6H15v4.5a3 3 0 1 1-6 0V15H4.5a3 3 0 1 1 0-6H9V4.5Z" /></>,
    edit: <><path d="m14 5 5 5L9 20l-5 1 1-5L15 6" /><path d="m13 7 4 4" /></>,
    trash: <><path d="M4 7h16M9 3h6l1 4H8l1-4Zm-3 4 1 14h10l1-14M10 11v6m4-6v6" /></>,
    warning: <><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5m0 3h.01" /></>
  }
  return <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function surfaceKey(surface: CmuxSurface): string { return `${surface.workspaceId}\u0000${surface.surfaceId}` }
function validTimezone(timezone: string): boolean { try { new Intl.DateTimeFormat('ko-KR', { timeZone: timezone }).format(); return true } catch { return false } }
function formatDate(value?: string): string { return value ? new Date(value).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—' }
function triggerLabel(trigger: Trigger): string { if (trigger.kind === 'manual') return '수동'; if (trigger.kind === 'interval') return `${trigger.seconds}초마다`; if (trigger.kind === 'daily') return `매일 ${trigger.time} · ${trigger.timezone}`; if (trigger.kind === 'cron') return `${trigger.expression} · ${trigger.timezone}`; if (trigger.kind === 'github') return `GitHub · ${trigger.repository}`; return 'Webhook' }
function statusLabel(status: AutomationRun['status']): string { return { queued: '대기', running: '실행 중', checking: '검사 중', succeeded: '성공', 'needs-review': '검토 필요', failed: '실패', cancelled: '취소됨', interrupted: '중단됨' }[status] }
function statusTone(status: AutomationRun['status']): string { return status === 'succeeded' ? 'good' : status === 'failed' || status === 'interrupted' ? 'bad' : status === 'needs-review' ? 'warn' : ACTIVE_STATUS[status] ? 'live' : '' }
function mergeLogs(current: RunLog[], incoming: RunLog[]): RunLog[] { const logs = new Map(current.map((log) => [log.seq, log])); for (const log of incoming) logs.set(log.seq, log); return [...logs.values()].sort((a, b) => a.seq - b.seq) }
