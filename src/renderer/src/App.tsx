import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { palace } from './api'
import type { AppView, LogLine, ProgressEvent, Settings } from '../../shared/types'
import { Detail } from './components/Detail'
import { AddAppModal, SettingsModal } from './components/Modals'
import { Onboarding } from './components/Onboarding'
import { AutomationConsole, type AutomationSection, type AutomationStatus } from './components/automation/AutomationConsole'
import { Icon } from './components/automation/ui'
import { LoopsView } from './components/workbench/LoopsView'
import { RemoteView } from './components/workbench/RemoteView'
import { SetupView } from './components/workbench/SetupView'
import { SkillsView } from './components/workbench/SkillsView'
import { WorkbenchIcon, type WorkbenchIconName } from './components/workbench/WorkbenchIcon'
import './automation.css'
import './workbench.css'

type Navigation = 'remote' | 'loops' | 'automations' | 'runs' | 'skills' | 'sync' | 'machine' | 'setup' | 'tools'

const NAVIGATION: Array<{ id: Navigation; label: string; description: string; icon: WorkbenchIconName }> = [
  { id: 'remote', label: 'OMP', description: 'cmux + OMP 개발', icon: 'terminal' },
  { id: 'loops', label: 'Loops', description: '자율 실행 엔진', icon: 'loop' },
  { id: 'automations', label: 'Automations', description: '예약 워크플로', icon: 'automation' },
  { id: 'runs', label: 'Runs', description: '실행 기록', icon: 'runs' },
  { id: 'skills', label: 'Skills', description: '.agent/skills', icon: 'skills' },
  { id: 'sync', label: 'OMP Sync', description: '프로필 동기화', icon: 'sync' },
  { id: 'machine', label: 'Machine', description: '로컬 실행 설정', icon: 'machine' },
  { id: 'setup', label: 'Setup', description: '새 컴퓨터 준비', icon: 'setup' },
  { id: 'tools', label: 'Legacy Tools', description: '도구 카탈로그', icon: 'tools' }
]

export default function App(): JSX.Element {
  const [navigation, setNavigation] = useState<Navigation>(() => new URLSearchParams(window.location.search).has('run') ? 'runs' : 'remote')
  const [mobileNav, setMobileNav] = useState(false)
  const [automationStatus, setAutomationStatus] = useState<AutomationStatus>({ online: false, running: 0 })
  const [apps, setApps] = useState<AppView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)
  const toastTimer = useRef<number | null>(null)

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current ?? undefined)
    toastTimer.current = window.setTimeout(() => setToast(null), 3800)
  }, [])
  const updateAutomationStatus = useCallback((status: AutomationStatus) => setAutomationStatus(status), [])

  useEffect(() => {
    palace.listApps().then((next) => { setApps(next); setSelectedId((current) => current ?? next[0]?.manifest.id ?? null) }).catch((reason) => showToast(reason instanceof Error ? reason.message : String(reason)))
    palace.getSettings().then(setSettings).catch((reason) => showToast(reason instanceof Error ? reason.message : String(reason)))
    const offState = palace.onStateChanged(setApps)
    const offLog = palace.onLog((line) => setLogs((previous) => {
      const next = previous[line.appId] ? [...previous[line.appId], line] : [line]
      if (next.length > 2000) next.splice(0, next.length - 2000)
      return { ...previous, [line.appId]: next }
    }))
    const offProgress = palace.onProgress((progress: ProgressEvent) => {
      if (progress.status === 'done' || progress.status === 'error') showToast(`${progress.appId} — ${progress.message}`)
    })
    return () => { offState(); offLog(); offProgress(); window.clearTimeout(toastTimer.current ?? undefined) }
  }, [showToast])

  const selected = useMemo(() => apps.find((app) => app.manifest.id === selectedId) ?? null, [apps, selectedId])
  const automationSection: AutomationSection = navigation === 'runs' ? 'runs' : navigation === 'sync' ? 'sync' : navigation === 'machine' ? 'machine' : 'automations'
  const automationVisible = navigation === 'automations' || navigation === 'runs' || navigation === 'sync' || navigation === 'machine'
  const navigate = (next: Navigation): void => { setNavigation(next); setMobileNav(false) }

  return <div className="wb-app">
    <aside className={`wb-global-nav ${mobileNav ? 'is-open' : ''}`}>
      <div className="wb-brand"><span className="wb-brand-mark">P</span><span><strong>Palace</strong><small>Native cmux + OMP</small></span><button className="wb-icon-button wb-mobile-only" type="button" aria-label="탐색 닫기" onClick={() => setMobileNav(false)}><WorkbenchIcon name="close" /></button></div>
      <nav aria-label="주요 탐색">
        <div className="wb-nav-section">Develop</div>
        {NAVIGATION.slice(0, 2).map((item) => <NavButton item={item} active={navigation === item.id} onClick={() => navigate(item.id)} key={item.id} />)}
        <div className="wb-nav-section">Operate</div>
        {NAVIGATION.slice(2, 6).map((item) => <NavButton item={item} active={navigation === item.id} count={item.id === 'runs' && automationStatus.running ? automationStatus.running : undefined} onClick={() => navigate(item.id)} key={item.id} />)}
        <div className="wb-nav-section">Configure</div>
        {NAVIGATION.slice(6).map((item) => <NavButton item={item} active={navigation === item.id} onClick={() => navigate(item.id)} key={item.id} />)}
      </nav>
      <div className="wb-global-status"><span className={`wb-status-light ${automationStatus.online ? 'is-on' : ''}`} /><span><strong>{automationStatus.online ? '로컬 서비스 연결됨' : '상태 확인 중'}</strong><small>{automationStatus.machineId || 'Palace OMP'}</small></span></div>
    </aside>
    <main className="wb-main">
      <div className="wb-titlebar"><button className="wb-icon-button wb-mobile-only" type="button" aria-label="메뉴 열기" onClick={() => setMobileNav(true)}><WorkbenchIcon name="menu" /></button><span>{NAVIGATION.find((item) => item.id === navigation)?.label}</span></div>
      <RemoteView visible={navigation === 'remote'} showToast={showToast} />
      <LoopsView visible={navigation === 'loops'} />
      <div className="wb-legacy-surface" hidden={!automationVisible}><AutomationConsole section={automationSection} hidden={!automationVisible} showToast={showToast} onStatusChange={updateAutomationStatus} /></div>
      <SkillsView visible={navigation === 'skills'} showToast={showToast} />
      <SetupView visible={navigation === 'setup'} showToast={showToast} />
      <ToolsWorkspace hidden={navigation !== 'tools'} apps={apps} selected={selected} selectedId={selectedId} logs={logs} onSelect={setSelectedId} onAdd={() => setShowAdd(true)} onSettings={() => setShowSettings(true)} onOnboarding={() => setShowOnboarding(true)} showToast={showToast} onRemoved={(id) => { setSelectedId((current) => current === id ? null : current); palace.listApps().then(setApps).catch((reason) => showToast(reason instanceof Error ? reason.message : String(reason))) }} />
    </main>
    <nav className="wb-mobile-tabs" aria-label="빠른 탐색">{NAVIGATION.slice(0, 5).map((item) => <button className={navigation === item.id ? 'is-active' : ''} type="button" onClick={() => navigate(item.id)} key={item.id}><WorkbenchIcon name={item.icon} /><span>{item.label}</span></button>)}<button type="button" onClick={() => setMobileNav(true)}><WorkbenchIcon name="menu" /><span>더보기</span></button></nav>
    {showAdd && <AddAppModal onClose={() => setShowAdd(false)} onAdded={(next, id) => { setApps(next); setSelectedId(id); setShowAdd(false); navigate('tools'); showToast(`추가됨 — ${id}`) }} />}
    {showSettings && settings && <SettingsModal settings={settings} onClose={() => setShowSettings(false)} onSaved={(next) => { setSettings(next); setShowSettings(false); palace.listApps().then(setApps).catch(() => undefined); showToast('설정 저장됨') }} />}
    {showOnboarding && <Onboarding showToast={showToast} onGoCatalog={() => { navigate('tools'); const firstAvailable = apps.find((app) => app.installState === 'not-installed'); if (firstAvailable) setSelectedId(firstAvailable.manifest.id) }} onClose={(dismiss) => { setShowOnboarding(false); if (dismiss) void palace.dismissOnboarding() }} />}
    {toast && <div className="toast wb-toast" role="status" aria-live="polite">{toast}</div>}
  </div>
}

function NavButton({ item, active, count, onClick }: { item: typeof NAVIGATION[number]; active: boolean; count?: number; onClick: () => void }): JSX.Element {
  return <button className={`wb-nav-item ${active ? 'is-active' : ''}`} type="button" aria-current={active ? 'page' : undefined} onClick={onClick}><span className="wb-nav-icon"><WorkbenchIcon name={item.icon} /></span><span><strong>{item.label}</strong><small>{item.description}</small></span>{count !== undefined && <em>{count}</em>}</button>
}

function ToolsWorkspace({ hidden, apps, selected, selectedId, logs, onSelect, onAdd, onSettings, onOnboarding, showToast, onRemoved }: { hidden: boolean; apps: AppView[]; selected: AppView | null; selectedId: string | null; logs: Record<string, LogLine[]>; onSelect: (id: string) => void; onAdd: () => void; onSettings: () => void; onOnboarding: () => void; showToast: (message: string) => void; onRemoved: (id: string) => void }): JSX.Element {
  const installed = apps.filter((app) => app.installState === 'installed' || app.installState === 'installing')
  const available = apps.filter((app) => app.installState === 'not-installed' || app.installState === 'error')
  return <div className="tools-workspace wb-tools-workspace" hidden={hidden}><aside className="tools-catalog" aria-label="도구 카탈로그"><div className="tools-catalog__head"><div><span className="auto-eyebrow">데스크톱 전용</span><h1>Legacy Tools</h1></div><button className="auto-icon-button" type="button" aria-label="도구 추가" onClick={onAdd}><Icon name="plus" /></button></div><div className="tools-catalog__list">{installed.length > 0 && <div className="section-label">설치됨</div>}{installed.map((app) => <AppItem key={app.manifest.id} app={app} active={app.manifest.id === selectedId} onClick={() => onSelect(app.manifest.id)} />)}{available.length > 0 && <div className="section-label">카탈로그</div>}{available.map((app) => <AppItem key={app.manifest.id} app={app} active={app.manifest.id === selectedId} onClick={() => onSelect(app.manifest.id)} />)}{apps.length === 0 && <div className="auto-compact-empty">등록된 도구가 없습니다.</div>}</div><div className="tools-catalog__foot"><button className="auto-button" type="button" onClick={onOnboarding}>새 컴퓨터 셋업</button><button className="auto-icon-button" type="button" aria-label="도구 설정" onClick={onSettings}><Icon name="machine" /></button></div></aside><div className="tools-detail">{selected ? <Detail key={selected.manifest.id} app={selected} logs={logs[selected.manifest.id] ?? []} showToast={showToast} onRemoved={onRemoved} /> : <div className="center-empty">왼쪽 카탈로그에서 도구를 선택하세요.</div>}</div></div>
}

function AppItem({ app, active, onClick }: { app: AppView; active: boolean; onClick: () => void }): JSX.Element {
  const dotClass = app.runState === 'running' ? 'running' : app.runState === 'starting' || app.installState === 'installing' ? 'starting' : app.installState === 'error' ? 'error' : app.installState === 'installed' ? 'installed' : ''
  const status = app.installState === 'installing' ? '설치 중…' : app.runState === 'running' ? '실행 중' : app.installState === 'installed' ? (app.git?.updateAvailable ? '업데이트 있음' : '정지됨') : '미설치'
  return <button type="button" className={`app-item ${active ? 'active' : ''}`} onClick={onClick}><span className={`dot ${dotClass}`} style={dotClass === 'installed' && app.manifest.accent ? { background: app.manifest.accent } : undefined} /><span className="app-item__copy"><span className="name">{app.manifest.name}</span><span className="mini">{status}{app.keepAwake?.active && ' · awake'}</span></span></button>
}
