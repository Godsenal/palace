import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { palace } from '../../api'
import type { AgentProfile, AgentQuestion, AgentSession, SessionDetail, SessionEvent, Workspace, WorkbenchSnapshot, WorkspaceChanges } from '../../../../shared/workbench'
import { Modal } from '../automation/ui'
import { RichText, formatDate, messageOf } from './RichText'
import { WorkbenchIcon } from './WorkbenchIcon'

type Model = { id: string; name: string; provider: string }
type SidePanel = 'files' | 'profiles' | null

const EMPTY: WorkbenchSnapshot = { workspaces: [], sessions: [], profiles: [] }
const THINKING_LEVELS = ['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh']

export function WorkspaceView({ visible, showToast, onOpenNative }: { visible: boolean; showToast: (message: string) => void; onOpenNative: () => void }): JSX.Element {
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>(EMPTY)
  const [models, setModels] = useState<Model[]>([])
  const [projects, setProjects] = useState<Array<{ name: string; path: string }>>([])
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [sidePanel, setSidePanel] = useState<SidePanel>(null)
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [showWorkspaceCreator, setShowWorkspaceCreator] = useState(false)
  const [showSessionCreator, setShowSessionCreator] = useState<'agent' | 'terminal' | null>(null)
  const [showHeartbeat, setShowHeartbeat] = useState(false)
  const [closeTarget, setCloseTarget] = useState<AgentSession | null>(null)
  const [mobileProjects, setMobileProjects] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const deepLinkHandled = useRef(false)

  const loadSnapshot = useCallback(async (): Promise<void> => {
    try {
      const next = await palace.ide.snapshot()
      setSnapshot(next)
      const linkedSessionId = !deepLinkHandled.current ? new URLSearchParams(window.location.search).get('session') : null
      const linkedSession = linkedSessionId ? next.sessions.find((item) => item.id === linkedSessionId) : null
      if (linkedSession) {
        deepLinkHandled.current = true
        setWorkspaceId(linkedSession.workspaceId)
        setSessionId(linkedSession.id)
        const url = new URL(window.location.href)
        url.searchParams.delete('session')
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
      } else {
        setWorkspaceId((current) => current && next.workspaces.some((item) => item.id === current) ? current : next.workspaces.find((item) => !item.archived)?.id ?? null)
      }
      setError(null)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.all([
      loadSnapshot(),
      palace.ide.models().then(setModels).catch((reason) => setError(messageOf(reason))),
      palace.automation.snapshot().then((value) => setProjects(Object.entries(value.settings.projectPaths).map(([name, path]) => ({ name, path })))).catch(() => undefined)
    ])
  }, [loadSnapshot])

  useEffect(() => {
    if (!visible) return
    const timer = window.setInterval(() => void loadSnapshot(), 3000)
    return () => window.clearInterval(timer)
  }, [visible, loadSnapshot])

  const workspaces = useMemo(() => snapshot.workspaces.filter((item) => !item.archived), [snapshot.workspaces])
  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId) ?? null
  const sessions = useMemo(() => snapshot.sessions.filter((item) => item.workspaceId === workspaceId), [snapshot.sessions, workspaceId])

  useEffect(() => {
    setSessionId((current) => current && sessions.some((item) => item.id === current) ? current : sessions[0]?.id ?? null)
  }, [sessions])

  useEffect(() => {
    if (!visible || !sessionId) { setDetail(null); return }
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const next = await palace.ide.detail(sessionId)
        if (alive) { setDetail(next); setError(null) }
      } catch (reason) {
        if (alive) setError(messageOf(reason))
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 800)
    return () => { alive = false; window.clearInterval(timer) }
  }, [visible, sessionId])

  useEffect(() => {
    if (!workspaceId || sidePanel !== 'files') return
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const next = await palace.ide.changes(workspaceId)
        if (alive) setChanges(next)
      } catch (reason) {
        if (alive) setError(messageOf(reason))
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 2500)
    return () => { alive = false; window.clearInterval(timer) }
  }, [workspaceId, sidePanel])

  const openFile = async (path: string): Promise<void> => {
    if (!workspaceId) return
    setSelectedFile(path); setFileContent(null)
    try { setFileContent(await palace.ide.readFile(workspaceId, path)) }
    catch (reason) { setError(messageOf(reason)) }
  }

  const activeSession = detail?.session ?? sessions.find((item) => item.id === sessionId) ?? null
  const updateProfiles = async (profiles: AgentProfile[]): Promise<void> => {
    try { await palace.ide.saveProfiles(profiles); setSnapshot((current) => ({ ...current, profiles })); showToast('에이전트 프로필을 저장했습니다') }
    catch (reason) { setError(messageOf(reason)) }
  }

  return <section className="wb-workspace-view" hidden={!visible} aria-label="에이전트 워크스페이스">
    <aside className={`wb-projects ${mobileProjects ? 'is-open' : ''}`}>
      <div className="wb-projects__head">
        <div><span className="wb-eyebrow">나의 프로젝트</span><h1>워크스페이스</h1></div>
        <button className="wb-icon-button" type="button" aria-label="워크스페이스 만들기" onClick={() => setShowWorkspaceCreator(true)}><WorkbenchIcon name="plus" /></button>
      </div>
      <div className="wb-project-list">
        {workspaces.map((workspace) => {
          const workspaceSessions = snapshot.sessions.filter((item) => item.workspaceId === workspace.id)
          const running = workspaceSessions.filter((item) => item.status === 'running' || item.status === 'waiting').length
          return <button className={`wb-project-item ${workspace.id === workspaceId ? 'is-active' : ''}`} type="button" key={workspace.id} onClick={() => { setWorkspaceId(workspace.id); setMobileProjects(false) }}>
            <span className="wb-project-glyph">{workspace.name.slice(0, 1).toUpperCase()}</span>
            <span className="wb-project-copy"><strong>{workspace.name}</strong><small>{workspace.branch || workspace.project}</small></span>
            {running > 0 && <span className="wb-live-count">{running}</span>}
          </button>
        })}
        {!loading && workspaces.length === 0 && <div className="wb-project-empty"><p>첫 프로젝트를 연결하고 에이전트나 터미널을 시작하세요.</p><button className="wb-button wb-button--primary" type="button" onClick={() => setShowWorkspaceCreator(true)}>프로젝트 연결</button></div>}
      </div>
      <div className="wb-projects__foot"><button className="wb-native-callout" type="button" onClick={onOpenNative}><WorkbenchIcon name="terminal" size={15} /><span><strong>cmux + OMP 열기</strong><small>기본 개발 환경</small></span><WorkbenchIcon name="external" size={13} /></button><span><WorkbenchIcon name="branch" size={14} /> Workbench는 고급 내장 도우미입니다</span></div>
    </aside>

    <div className="wb-stage">
      <header className="wb-session-bar">
        <button className="wb-icon-button wb-mobile-only" type="button" aria-label="프로젝트 목록" onClick={() => setMobileProjects((value) => !value)}><WorkbenchIcon name="menu" /></button>
        <div className="wb-session-tabs" role="tablist" aria-label="세션">
          {sessions.map((session) => <button role="tab" aria-selected={session.id === sessionId} className={`wb-session-tab ${session.id === sessionId ? 'is-active' : ''}`} type="button" key={session.id} onClick={() => setSessionId(session.id)}>
            <WorkbenchIcon name={session.kind === 'terminal' ? 'terminal' : 'agent'} size={15} />
            <span>{session.name}</span><StatusDot status={session.status} />
          </button>)}
        </div>
        {selectedWorkspace && <div className="wb-session-actions">
          <button className="wb-button" type="button" onClick={() => setShowSessionCreator('terminal')}><WorkbenchIcon name="terminal" /> <span className="wb-action-label">터미널</span></button>
          <button className="wb-button wb-button--primary" type="button" onClick={() => setShowSessionCreator('agent')}><WorkbenchIcon name="plus" /> <span className="wb-action-label">에이전트</span></button>
        </div>}
      </header>

      {error && <div className="wb-error" role="alert"><WorkbenchIcon name="warning" /><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="오류 닫기"><WorkbenchIcon name="close" size={14} /></button></div>}

      {!selectedWorkspace ? <WorkspaceWelcome onCreate={() => setShowWorkspaceCreator(true)} /> : !activeSession ? <SessionWelcome workspace={selectedWorkspace} onCreate={setShowSessionCreator} /> : <>
        <div className="wb-context-bar">
          <div className="wb-context-copy"><strong>{activeSession.name}</strong><span>{selectedWorkspace.name} · {activeSession.model || 'Auto'} · {statusLabel(activeSession.status)}</span></div>
          <div className="wb-context-actions">
            {activeSession.kind === 'agent' && <button className={`wb-icon-button ${activeSession.heartbeat?.enabled ? 'is-accent' : ''}`} type="button" aria-label="하트비트 설정" onClick={() => setShowHeartbeat(true)}><WorkbenchIcon name="heart" /></button>}
            <button className={`wb-icon-button ${sidePanel === 'files' ? 'is-active' : ''}`} type="button" aria-label="파일과 변경 사항" onClick={() => setSidePanel((value) => value === 'files' ? null : 'files')}><WorkbenchIcon name="files" /></button>
            <button className={`wb-icon-button ${sidePanel === 'profiles' ? 'is-active' : ''}`} type="button" aria-label="에이전트 프로필" onClick={() => setSidePanel((value) => value === 'profiles' ? null : 'profiles')}><WorkbenchIcon name="agent" /></button>
            <button className="wb-icon-button" type="button" aria-label="세션 닫기" onClick={() => setCloseTarget(activeSession)}><WorkbenchIcon name="close" /></button>
          </div>
        </div>
        <div className={`wb-session-body ${sidePanel ? 'has-panel' : ''}`}>
          <div className="wb-primary-pane">
            {activeSession.kind === 'terminal' ? <TerminalSession detail={detail} onError={setError} /> : <AgentConversation detail={detail} models={models} profiles={snapshot.profiles} onRefresh={loadSnapshot} onError={setError} />}
          </div>
          {sidePanel === 'files' && <FilesPanel changes={changes} selectedFile={selectedFile} content={fileContent} onSelect={(path) => void openFile(path)} onClose={() => setSidePanel(null)} />}
          {sidePanel === 'profiles' && <ProfilesPanel profiles={snapshot.profiles} models={models} onSave={(profiles) => void updateProfiles(profiles)} onClose={() => setSidePanel(null)} />}
        </div>
      </>}
    </div>

    {showWorkspaceCreator && <WorkspaceCreator projects={projects} onClose={() => setShowWorkspaceCreator(false)} onCreated={async (workspace) => { setShowWorkspaceCreator(false); await loadSnapshot(); setWorkspaceId(workspace.id); showToast('워크스페이스를 만들었습니다') }} onError={setError} />}
    {showSessionCreator && selectedWorkspace && <SessionCreator kind={showSessionCreator} workspace={selectedWorkspace} models={models} profiles={snapshot.profiles} onClose={() => setShowSessionCreator(null)} onCreated={async (session) => { setShowSessionCreator(null); await loadSnapshot(); setSessionId(session.id) }} onError={setError} />}
    {showHeartbeat && activeSession?.kind === 'agent' && <HeartbeatEditor session={activeSession} onClose={() => setShowHeartbeat(false)} onSaved={() => { setShowHeartbeat(false); void loadSnapshot() }} onError={setError} />}
    {closeTarget && <Modal title="세션 닫기" description={closeTarget.name} onClose={() => setCloseTarget(null)} width="small" footer={<><button className="auto-button" type="button" onClick={() => setCloseTarget(null)}>취소</button><button className="auto-button auto-button--danger" type="button" onClick={() => { const id = closeTarget.id; setCloseTarget(null); palace.ide.closeSession(id).then(() => loadSnapshot()).catch((reason) => setError(messageOf(reason))) }}>세션 닫기</button></>}><p>{closeTarget.status === 'running' || closeTarget.status === 'waiting' ? '실행 중인 작업을 중단하고 이 세션을 닫습니다.' : '세션 기록 파일은 보존될 수 있지만 현재 탭에서는 제거됩니다.'}</p></Modal>}
  </section>
}

function WorkspaceWelcome({ onCreate }: { onCreate: () => void }): JSX.Element {
  return <div className="wb-welcome"><div className="wb-welcome__mark"><WorkbenchIcon name="workspace" size={30} /></div><span className="wb-eyebrow">ADVANCED IN-APP HELPER</span><h2>Palace 안에서 세션을 보조 관리</h2><p>주 개발 환경은 cmux + OMP입니다. 이 Workbench는 Palace 안에서 별도 에이전트, 터미널, 변경 사항을 관리할 때 사용하세요.</p><button className="wb-button wb-button--primary" type="button" onClick={onCreate}><WorkbenchIcon name="plus" /> 보조 워크스페이스 만들기</button></div>
}

function SessionWelcome({ workspace, onCreate }: { workspace: Workspace; onCreate: (kind: 'agent' | 'terminal') => void }): JSX.Element {
  return <div className="wb-welcome"><div className="wb-welcome__mark"><WorkbenchIcon name="agent" size={30} /></div><span className="wb-eyebrow">{workspace.name}</span><h2>무엇을 시작할까요?</h2><p>전문 프로필을 고른 에이전트와 실제 터미널을 동시에 열 수 있습니다.</p><div className="wb-welcome__actions"><button className="wb-button wb-button--primary" type="button" onClick={() => onCreate('agent')}><WorkbenchIcon name="agent" /> 에이전트 시작</button><button className="wb-button" type="button" onClick={() => onCreate('terminal')}><WorkbenchIcon name="terminal" /> 터미널 열기</button></div></div>
}

function StatusDot({ status }: { status: AgentSession['status'] }): JSX.Element {
  return <span className={`wb-status-dot is-${status}`} title={statusLabel(status)} />
}

function statusLabel(status: AgentSession['status']): string {
  return ({ idle: '대기', running: '작업 중', waiting: '응답 대기', stopped: '중지됨', error: '실패' })[status]
}

function AgentConversation({ detail, models, profiles, onRefresh, onError }: { detail: SessionDetail | null; models: Model[]; profiles: AgentProfile[]; onRefresh: () => Promise<void>; onError: (value: string) => void }): JSX.Element {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'prompt' | 'steer' | 'follow_up'>('prompt')
  const [sending, setSending] = useState(false)
  const [questionBusy, setQuestionBusy] = useState<string | null>(null)
  const [modelBusy, setModelBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const session = detail?.session
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [detail?.events.length, detail?.questions.length])
  useEffect(() => { if (!session || session.status === 'idle') setMode('prompt'); else if (session.status === 'running') setMode('steer'); else setMode('follow_up') }, [session?.status])

  const send = async (): Promise<void> => {
    if (!session || !text.trim() || sending) return
    const value = text.trim(); setText(''); setSending(true)
    try { await palace.ide.prompt(session.id, value, mode) }
    catch (reason) { setText(value); onError(messageOf(reason)) }
    finally { setSending(false) }
  }
  const respond = async (question: AgentQuestion, response: unknown): Promise<void> => {
    if (!session) return
    setQuestionBusy(question.id)
    try { await palace.ide.respond(session.id, question.id, response) }
    catch (reason) { onError(messageOf(reason)) }
    finally { setQuestionBusy(null) }
  }
  const action = async (name: 'abort' | 'resume'): Promise<void> => {
    if (!session) return
    try { await palace.ide[name](session.id); await onRefresh() }
    catch (reason) { onError(messageOf(reason)) }
  }
  const changeModel = async (modelId: string): Promise<void> => {
    if (!session || !modelId) return
    const model = models.find((item) => `${item.provider}/${item.id}` === modelId)
    if (!model) { onError('선택한 모델 정보를 찾을 수 없습니다.'); return }
    setModelBusy(true)
    try {
      await palace.ide.command(session.id, 'set_model', { provider: model.provider, modelId: model.id })
      await onRefresh()
    } catch (reason) {
      onError(messageOf(reason))
    } finally {
      setModelBusy(false)
    }
  }

  if (!detail || !session) return <div className="wb-loading"><span className="spin" /> 세션을 불러오는 중</div>
  return <div className="wb-conversation">
    <div className="wb-messages" aria-live="polite">
      {detail.events.length === 0 && <div className="wb-conversation-empty"><WorkbenchIcon name="agent" size={26} /><strong>에이전트에게 작업을 맡겨보세요</strong><p>목표와 완료 조건을 자연어로 설명하면 됩니다. 모델은 {session.model || 'Auto'}로 실행됩니다.</p></div>}
      {detail.events.map((event) => <EventCard event={event} key={event.seq} />)}
      {detail.questions.map((question) => <QuestionCard question={question} busy={questionBusy === question.id} onRespond={(response) => void respond(question, response)} key={question.id} />)}
      {session.error && <div className="wb-message wb-message--error"><WorkbenchIcon name="warning" /><div><strong>세션 오류</strong><p>{session.error}</p></div></div>}
      <div ref={end} />
    </div>
    <div className="wb-composer-wrap">
      <div className="wb-composer-mode">
        <select aria-label="메시지 동작" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
          <option value="prompt">새 작업</option><option value="steer">진행 중 지시</option><option value="follow_up">후속 작업</option>
        </select>
        <select aria-label="현재 모델" value={session.model && session.model.toLowerCase() !== 'auto' ? session.model : ''} disabled={modelBusy} onChange={(event) => void changeModel(event.target.value)}><option value="" disabled={!!session.model && session.model.toLowerCase() !== 'auto'}>Auto · OMP 기본값</option>{session.model && session.model.toLowerCase() !== 'auto' && !models.some((model) => `${model.provider}/${model.id}` === session.model) && <option value={session.model} disabled>{session.model} · 현재</option>}{models.map((model) => <option value={`${model.provider}/${model.id}`} key={`${model.provider}/${model.id}`}>{model.name}</option>)}</select>
        {session.profileId && <span>{profiles.find((item) => item.id === session.profileId)?.name || '프로필'}</span>}
        <span className="wb-composer-spacer" />
        {session.status === 'running' || session.status === 'waiting' ? <button className="wb-text-button is-danger" type="button" onClick={() => void action('abort')}><WorkbenchIcon name="stop" size={14} /> 중단</button> : session.status === 'stopped' || session.status === 'error' ? <button className="wb-text-button" type="button" onClick={() => void action('resume')}><WorkbenchIcon name="play" size={14} /> 재개</button> : null}
      </div>
      <div className="wb-composer">
        <textarea rows={3} value={text} placeholder={mode === 'steer' ? '진행 중인 에이전트에게 방향을 알려주세요…' : mode === 'follow_up' ? '다음에 할 일을 이어서 요청하세요…' : '에이전트에게 맡길 일을 설명하세요…'} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} />
        <button className="wb-send-button" type="button" disabled={!text.trim() || sending} onClick={() => void send()} aria-label="메시지 보내기">{sending ? <span className="spin" /> : <WorkbenchIcon name="send" />}</button>
      </div>
      <small>Enter 전송 · Shift+Enter 줄바꿈</small>
    </div>
  </div>
}

function EventCard({ event }: { event: SessionEvent }): JSX.Element {
  if (event.kind === 'user') return <article className="wb-message wb-message--user"><div className="wb-message-meta"><span>나</span><time>{formatDate(event.at)}</time></div><RichText text={event.text} /></article>
  if (event.kind === 'assistant') return <article className="wb-message wb-message--assistant"><div className="wb-message-meta"><span><WorkbenchIcon name="agent" size={14} /> 에이전트</span><time>{formatDate(event.at)}</time></div><RichText text={event.text} /></article>
  if (event.kind === 'thinking') return <details className="wb-process-card"><summary><span className="wb-process-icon"><WorkbenchIcon name="automation" size={15} /></span><span>생각하는 중</span><time>{formatDate(event.at)}</time></summary><RichText text={event.text} /></details>
  if (event.kind === 'tool') {
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : null
    const phase = data?.phase === 'start' ? '실행 중' : data?.phase === 'end' ? '완료' : '도구'
    return <details className={`wb-process-card wb-process-card--tool ${data?.phase === 'start' ? 'is-running' : ''}`} open={data?.phase === 'start'}><summary><span className="wb-process-icon"><WorkbenchIcon name="tools" size={15} /></span><span>{event.text || '도구 호출'}</span><em>{phase}</em></summary>{data && <pre>{JSON.stringify(data.raw ?? data, null, 2)}</pre>}</details>
  }
  if (event.kind === 'terminal') return <pre className="wb-inline-terminal">{event.text}</pre>
  return <div className={`wb-system-event ${event.kind === 'error' ? 'is-error' : ''}`}><WorkbenchIcon name={event.kind === 'error' ? 'warning' : 'check'} size={14} /><span>{event.text}</span></div>
}

function QuestionCard({ question, busy, onRespond }: { question: AgentQuestion; busy: boolean; onRespond: (response: unknown) => void }): JSX.Element {
  const [custom, setCustom] = useState('')
  const options = Array.isArray(question.options) ? question.options : []
  return <article className="wb-question-card" role="group" aria-label={question.title}>
    <div className="wb-question-card__head"><span><WorkbenchIcon name="warning" size={16} /></span><div><strong>{question.title}</strong><small>에이전트가 응답을 기다립니다</small></div></div>
    {question.message && <RichText text={question.message} />}
    {options.length > 0 && <div className="wb-question-options">{options.map((option, index) => {
      const record = option && typeof option === 'object' ? option as Record<string, unknown> : null
      const label = String(record?.label ?? record?.title ?? option)
      const value = record?.value ?? record?.id ?? option
      return <button className="wb-button" type="button" disabled={busy} onClick={() => onRespond(value)} key={`${label}-${index}`}>{label}</button>
    })}</div>}
    {question.method !== 'confirm' && <div className="wb-question-custom"><input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder={question.method === 'editor' ? '답변 내용을 입력하세요' : '직접 응답'} /><button className="wb-button wb-button--primary" type="button" disabled={busy || !custom.trim()} onClick={() => onRespond(custom.trim())}>{busy ? <span className="spin" /> : '응답'}</button></div>}
  </article>
}

function TerminalSession({ detail, onError }: { detail: SessionDetail | null; onError: (value: string) => void }): JSX.Element {
  const [input, setInput] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const shell = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [detail?.events.length])
  useEffect(() => {
    if (!detail || !shell.current || typeof ResizeObserver === 'undefined') return
    const sessionId = detail.session.id
    const observer = new ResizeObserver(([entry]) => {
      const columns = Math.max(20, Math.floor((entry.contentRect.width - 28) / 7))
      const rows = Math.max(5, Math.floor((entry.contentRect.height - 58) / 17))
      void palace.ide.command(sessionId, 'terminal.resize', { columns, rows }).catch((reason) => onError(messageOf(reason)))
    })
    observer.observe(shell.current)
    return () => observer.disconnect()
  }, [detail?.session.id, onError])
  if (!detail) return <div className="wb-loading"><span className="spin" /> 터미널 연결 중</div>
  const send = async (): Promise<void> => {
    if (!input) return
    const data = `${input}\n`; setInput('')
    try { await palace.ide.command(detail.session.id, 'terminal.input', { data }) }
    catch (reason) { setInput(input); onError(messageOf(reason)) }
  }
  return <div className="wb-terminal-shell" ref={shell}>
    <div className="wb-terminal-output" role="log" aria-live="polite">{detail.events.map((event) => <pre className={event.kind === 'error' ? 'is-error' : ''} key={event.seq}>{event.text}</pre>)}<div ref={end} /></div>
    <form className="wb-terminal-input" onSubmit={(event) => { event.preventDefault(); void send() }}><span>$</span><input autoComplete="off" spellCheck={false} value={input} onChange={(event) => setInput(event.target.value)} aria-label="터미널 입력" /><button type="submit" aria-label="명령 보내기"><WorkbenchIcon name="send" size={15} /></button></form>
  </div>
}

function FilesPanel({ changes, selectedFile, content, onSelect, onClose }: { changes: WorkspaceChanges | null; selectedFile: string | null; content: string | null; onSelect: (path: string) => void; onClose: () => void }): JSX.Element {
  const [tab, setTab] = useState<'files' | 'diff'>('files')
  return <aside className="wb-side-panel">
    <div className="wb-side-panel__head"><div className="wb-mini-tabs"><button className={tab === 'files' ? 'is-active' : ''} type="button" onClick={() => setTab('files')}>파일</button><button className={tab === 'diff' ? 'is-active' : ''} type="button" onClick={() => setTab('diff')}>Diff</button></div><button className="wb-icon-button" type="button" aria-label="패널 닫기" onClick={onClose}><WorkbenchIcon name="close" /></button></div>
    {!changes ? <div className="wb-loading"><span className="spin" /> 변경 사항 확인 중</div> : tab === 'diff' ? <pre className="wb-diff">{changes.diff || '변경 사항이 없습니다.'}{changes.truncated ? '\n\n… 출력이 잘렸습니다.' : ''}</pre> : <div className="wb-files-content">
      <div className="wb-file-list">{changes.files.map((file) => <button className={selectedFile === file.path ? 'is-active' : ''} type="button" onClick={() => onSelect(file.path)} key={file.path}><span className={`wb-file-status is-${file.status.slice(0, 1).toLowerCase()}`}>{file.status}</span><span>{file.path}</span></button>)}{changes.files.length === 0 && <p>변경된 파일이 없습니다.</p>}</div>
      {selectedFile && <div className="wb-file-preview"><div><span>{selectedFile}</span></div><pre>{content ?? '파일을 읽는 중…'}</pre></div>}
    </div>}
  </aside>
}

function ProfilesPanel({ profiles, models, onSave, onClose }: { profiles: AgentProfile[]; models: Model[]; onSave: (profiles: AgentProfile[]) => void; onClose: () => void }): JSX.Element {
  const [drafts, setDrafts] = useState(() => structuredClone(profiles))
  const [selected, setSelected] = useState(0)
  const profile = drafts[selected]
  const patch = (value: Partial<AgentProfile>): void => setDrafts((current) => current.map((item, index) => index === selected ? { ...item, ...value } : item))
  const add = (): void => { setDrafts((current) => [...current, { id: `profile-${Date.now().toString(36)}`, name: '새 프로필', model: 'Auto', thinking: 'auto', instructions: '', whenToUse: '' }]); setSelected(drafts.length) }
  return <aside className="wb-side-panel wb-profiles-panel">
    <div className="wb-side-panel__head"><strong>에이전트 프로필</strong><button className="wb-icon-button" type="button" aria-label="패널 닫기" onClick={onClose}><WorkbenchIcon name="close" /></button></div>
    <div className="wb-profile-list">{drafts.map((item, index) => <button className={index === selected ? 'is-active' : ''} type="button" onClick={() => setSelected(index)} key={item.id}><span>{item.name}</span><small>{item.model || 'Auto'}</small></button>)}<button className="wb-text-button" type="button" onClick={add}><WorkbenchIcon name="plus" size={14} /> 프로필 추가</button></div>
    {profile ? <div className="wb-profile-form"><label><span>이름</span><input value={profile.name} onChange={(event) => patch({ name: event.target.value })} /></label><label><span>모델</span><select value={profile.model || 'Auto'} onChange={(event) => patch({ model: event.target.value })}><option value="Auto">Auto · OMP 기본값</option>{profile.model && profile.model !== 'Auto' && !models.some((model) => `${model.provider}/${model.id}` === profile.model) && <option value={profile.model}>{profile.model} · 기존 설정</option>}{models.map((model) => <option value={`${model.provider}/${model.id}`} key={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}</select></label><label><span>Thinking</span><select value={profile.thinking} onChange={(event) => patch({ thinking: event.target.value })}>{THINKING_LEVELS.map((level) => <option value={level} key={level}>{level === 'auto' ? 'Auto' : level}</option>)}</select></label><label><span>언제 사용하나요?</span><textarea rows={3} value={profile.whenToUse} onChange={(event) => patch({ whenToUse: event.target.value })} placeholder="예: UI 품질 개선과 접근성 검토" /></label><label><span>전문 지침</span><textarea rows={8} value={profile.instructions} onChange={(event) => patch({ instructions: event.target.value })} placeholder="이 프로필의 역할과 작업 방식을 자연어로 적으세요." /></label><div className="wb-profile-actions"><button className="wb-button is-danger" type="button" onClick={() => { setDrafts((current) => current.filter((_, index) => index !== selected)); setSelected(Math.max(0, selected - 1)) }}><WorkbenchIcon name="trash" size={14} /> 삭제</button><button className="wb-button wb-button--primary" type="button" onClick={() => onSave(drafts)}>프로필 저장</button></div></div> : <div className="wb-panel-empty">프로필을 추가하세요.</div>}
  </aside>
}

function WorkspaceCreator({ projects, onClose, onCreated, onError }: { projects: Array<{ name: string; path: string }>; onClose: () => void; onCreated: (workspace: Workspace) => void; onError: (value: string) => void }): JSX.Element {
  const [available, setAvailable] = useState(projects)
  const [project, setProject] = useState(projects[0]?.name ?? '')
  const [name, setName] = useState(projects[0]?.name ?? '')
  const [isolated, setIsolated] = useState(true)
  const [busy, setBusy] = useState(false)
  const choose = async (): Promise<void> => {
    try {
      const chosen = await palace.setup.chooseProject()
      if (!chosen) return
      setAvailable((current) => current.some((item) => item.name === chosen.name) ? current : [...current, chosen])
      setProject(chosen.name)
      setName(chosen.name)
    } catch (reason) {
      onError(messageOf(reason))
    }
  }
  const create = async (): Promise<void> => {
    if (!project || !name.trim()) return
    setBusy(true)
    try {
      onCreated(await palace.ide.createWorkspace({ project, name: name.trim(), isolated }))
    } catch (reason) {
      onError(messageOf(reason))
      setBusy(false)
    }
  }
  return <Modal title="워크스페이스 만들기" description="프로젝트를 선택하면 에이전트와 터미널이 이 컨텍스트를 공유합니다." onClose={onClose} width="medium" footer={<><button className="auto-button" type="button" onClick={onClose}>취소</button><button className="auto-button auto-button--primary" type="button" disabled={busy || !project || !name.trim()} onClick={() => void create()}>{busy ? '만드는 중…' : '워크스페이스 만들기'}</button></>}>
    <div className="wb-modal-form">
      <label><span>프로젝트</span><div className="wb-input-action"><select value={project} onChange={(event) => { setProject(event.target.value); const item = available.find((candidate) => candidate.name === event.target.value); if (item) setName(item.name) }}><option value="">프로젝트 선택</option>{available.map((item) => <option value={item.name} key={item.name}>{item.name}</option>)}</select><button className="wb-button" type="button" onClick={() => void choose()}><WorkbenchIcon name="files" size={14} /> 폴더 연결</button></div></label>
      {project && <div className="wb-path-preview"><WorkbenchIcon name="files" size={14} />{available.find((item) => item.name === project)?.path}</div>}
      <label><span>워크스페이스 이름</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="wb-toggle-row"><input type="checkbox" checked={isolated} onChange={(event) => setIsolated(event.target.checked)} /><span><strong>격리된 Git 브랜치 사용</strong><small>현재 프로젝트와 충돌하지 않는 별도 작업 공간을 만듭니다.</small></span></label>
      {!available.length && <div className="wb-empty-inline">먼저 프로젝트 폴더를 연결하세요.</div>}
    </div>
  </Modal>
}

function SessionCreator({ kind, workspace, models, profiles, onClose, onCreated, onError }: { kind: 'agent' | 'terminal'; workspace: Workspace; models: Model[]; profiles: AgentProfile[]; onClose: () => void; onCreated: (session: AgentSession) => void; onError: (value: string) => void }): JSX.Element {
  const [name, setName] = useState(kind === 'agent' ? '새 에이전트' : '터미널')
  const [model, setModel] = useState('')
  const [profileId, setProfileId] = useState('')
  const [busy, setBusy] = useState(false)
  const create = async (): Promise<void> => {
    setBusy(true)
    try { onCreated(await palace.ide.createSession({ workspaceId: workspace.id, name: name.trim(), kind, model: kind === 'agent' ? model || undefined : undefined, profileId: kind === 'agent' ? profileId || undefined : undefined })) }
    catch (reason) { onError(messageOf(reason)); setBusy(false) }
  }
  return <Modal title={kind === 'agent' ? '에이전트 시작' : '터미널 열기'} description={`${workspace.name} 워크스페이스에서 새 세션을 엽니다.`} onClose={onClose} width="medium" footer={<><button className="auto-button" type="button" onClick={onClose}>취소</button><button className="auto-button auto-button--primary" type="button" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? '여는 중…' : kind === 'agent' ? '에이전트 시작' : '터미널 열기'}</button></>}><div className="wb-modal-form"><label><span>세션 이름</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>{kind === 'agent' && <><label><span>전문 프로필</span><select value={profileId} onChange={(event) => { const value = event.target.value; setProfileId(value); const profile = profiles.find((item) => item.id === value); if (profile) setModel(profile.model === 'Auto' ? '' : profile.model) }}><option value="">프로필 없이 시작</option>{profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name} · {profile.whenToUse || '사용자 정의'}</option>)}</select></label><label><span>모델</span><select value={model} onChange={(event) => setModel(event.target.value)}><option value="">Auto · OMP 기본값</option>{model && !models.some((item) => `${item.provider}/${item.id}` === model) && <option value={model}>{model} · 프로필 설정</option>}{models.map((item) => <option value={`${item.provider}/${item.id}`} key={`${item.provider}/${item.id}`}>{item.name} · {item.provider}</option>)}</select></label></>}</div></Modal>
}

function HeartbeatEditor({ session, onClose, onSaved, onError }: { session: AgentSession; onClose: () => void; onSaved: () => void; onError: (value: string) => void }): JSX.Element {
  const current = session.heartbeat
  const [enabled, setEnabled] = useState(current?.enabled ?? false)
  const [seconds, setSeconds] = useState(current?.seconds ?? 300)
  const [maxRuns, setMaxRuns] = useState(current?.maxRuns ?? 12)
  const [prompt, setPrompt] = useState(current?.prompt ?? '진행 상황을 확인하고 남은 작업을 계속하세요.')
  const [busy, setBusy] = useState(false)
  const save = async (): Promise<void> => {
    setBusy(true)
    try { await palace.ide.heartbeat(session.id, enabled ? { enabled, seconds, maxRuns, prompt, runs: current?.runs ?? 0 } : null); onSaved() }
    catch (reason) { onError(messageOf(reason)); setBusy(false) }
  }
  return <Modal title="하트비트" description="중단된 작업을 정해진 간격으로 명시적으로 다시 확인합니다." onClose={onClose} width="small" footer={<><button className="auto-button" type="button" onClick={onClose}>취소</button><button className="auto-button auto-button--primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? '저장 중…' : '저장'}</button></>}><div className="wb-modal-form"><label className="wb-check-row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span><strong>하트비트 사용</strong><small>켜져 있을 때만 자동으로 다시 실행합니다.</small></span></label><label><span>간격</span><select value={seconds} disabled={!enabled} onChange={(event) => setSeconds(Number(event.target.value))}><option value={60}>1분</option><option value={300}>5분</option><option value={900}>15분</option><option value={1800}>30분</option><option value={3600}>1시간</option></select></label><label><span>최대 실행 횟수</span><select value={maxRuns} disabled={!enabled} onChange={(event) => setMaxRuns(Number(event.target.value))}><option value={3}>3회</option><option value={6}>6회</option><option value={12}>12회</option><option value={24}>24회</option></select></label><label><span>확인 지시</span><textarea rows={4} disabled={!enabled} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>{current && <small>현재 {current.runs}회 실행됨</small>}</div></Modal>
}
