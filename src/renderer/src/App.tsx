import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { palace } from './api'
import type { AppView, LogLine, ProgressEvent, Settings } from '../../shared/types'
import { Detail } from './components/Detail'
import { AddAppModal, SettingsModal } from './components/Modals'

export default function App(): JSX.Element {
  const [apps, setApps] = useState<AppView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({})
  const [toast, setToast] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 3800)
  }, [])

  // 초기 로드 + 구독
  useEffect(() => {
    palace.listApps().then((a) => {
      setApps(a)
      setSelectedId((cur) => cur ?? a[0]?.manifest.id ?? null)
    })
    palace.getSettings().then(setSettings)

    const offState = palace.onStateChanged((next) => setApps(next))
    const offLog = palace.onLog((l) => {
      setLogs((prev) => {
        const arr = prev[l.appId] ? [...prev[l.appId], l] : [l]
        if (arr.length > 2000) arr.splice(0, arr.length - 2000)
        return { ...prev, [l.appId]: arr }
      })
    })
    const offProgress = palace.onProgress((p: ProgressEvent) => {
      if (p.status === 'done') showToast(`${p.appId} — ${p.message}`)
      if (p.status === 'error') showToast(`⚠ ${p.appId} — ${p.message}`)
    })
    return () => {
      offState()
      offLog()
      offProgress()
    }
  }, [showToast])

  const selected = useMemo(
    () => apps.find((a) => a.manifest.id === selectedId) ?? null,
    [apps, selectedId]
  )

  const installed = apps.filter((a) => a.installState === 'installed' || a.installState === 'installing')
  const available = apps.filter((a) => a.installState === 'not-installed' || a.installState === 'error')

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="brand">
            <span className="crown">👑</span> palace
          </div>
          <div className="brand-sub">당신의 도구 왕국 · 관제탑</div>
        </div>
        <div className="applist">
          {installed.length > 0 && <div className="section-label">설치됨</div>}
          {installed.map((a) => (
            <AppItem key={a.manifest.id} app={a} active={a.manifest.id === selectedId} onClick={() => setSelectedId(a.manifest.id)} />
          ))}
          {available.length > 0 && <div className="section-label">카탈로그</div>}
          {available.map((a) => (
            <AppItem key={a.manifest.id} app={a} active={a.manifest.id === selectedId} onClick={() => setSelectedId(a.manifest.id)} />
          ))}
        </div>
        <div className="sidebar-foot">
          <button className="btn ghost sm" style={{ flex: 1 }} onClick={() => setShowAdd(true)}>
            ＋ 앱 추가
          </button>
          <button className="iconbtn" title="설정" onClick={() => setShowSettings(true)}>
            ⚙
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar" />
        {selected ? (
          <Detail
            key={selected.manifest.id}
            app={selected}
            logs={logs[selected.manifest.id] ?? []}
            showToast={showToast}
            onRemoved={(id) => {
              setSelectedId((cur) => (cur === id ? null : cur))
              palace.listApps().then(setApps)
            }}
          />
        ) : (
          <div className="center-empty">왼쪽에서 앱을 선택하세요</div>
        )}
      </main>

      {showAdd && (
        <AddAppModal
          onClose={() => setShowAdd(false)}
          onAdded={(list, id) => {
            setApps(list)
            setSelectedId(id)
            setShowAdd(false)
            showToast(`추가됨 — ${id}`)
          }}
        />
      )}
      {showSettings && settings && (
        <SettingsModal
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(s) => {
            setSettings(s)
            setShowSettings(false)
            palace.listApps().then(setApps)
            showToast('설정 저장됨')
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function AppItem({ app, active, onClick }: { app: AppView; active: boolean; onClick: () => void }): JSX.Element {
  const dotClass =
    app.runState === 'running'
      ? 'running'
      : app.runState === 'starting'
        ? 'starting'
        : app.installState === 'installing'
          ? 'starting'
          : app.installState === 'error'
            ? 'error'
            : app.installState === 'installed'
              ? 'installed'
              : ''
  const status =
    app.installState === 'installing'
      ? '설치 중…'
      : app.runState === 'running'
        ? '실행 중'
        : app.installState === 'installed'
          ? (app.git?.updateAvailable ? '업데이트 있음' : '정지됨')
          : '미설치'
  return (
    <div className={`app-item ${active ? 'active' : ''}`} onClick={onClick}>
      <span className={`dot ${dotClass}`} style={dotClass === 'installed' && app.manifest.accent ? { background: app.manifest.accent } : undefined} />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div className="name">{app.manifest.name}</div>
        <div className="mini">{status}</div>
      </div>
    </div>
  )
}
