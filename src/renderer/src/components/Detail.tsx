import { useState } from 'react'
import { palace } from '../api'
import type { AppView } from '../../../shared/types'
import { DashboardEmbed } from './DashboardEmbed'
import { LogsView } from './LogsView'
import { Docs } from './Docs'
import { Doctor } from './Doctor'
import { EnvEditor } from './EnvEditor'
import type { LogLine } from '../../../shared/types'

type Tab = 'overview' | 'dashboard' | 'logs' | 'docs' | 'doctor' | 'env'

export function Detail({
  app,
  logs,
  showToast,
  onRemoved
}: {
  app: AppView
  logs: LogLine[]
  showToast: (m: string) => void
  onRemoved: (id: string) => void
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState<string | null>(null)
  const m = app.manifest
  const installed = app.installState === 'installed'
  const running = app.runState === 'running'
  const managed = !!app.pid

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      showToast(`⚠ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const doInstall = (): Promise<void> => run('install', () => palace.install(m.id))
  const doUpdate = (): Promise<void> => run('update', () => palace.update(m.id))
  const doStart = (): Promise<void> =>
    run('start', async () => {
      if (m.launchMode === 'process') await palace.start(m.id)
      else {
        const r = await palace.openInCmux(m.id)
        showToast(r.message)
      }
    })
  const doStop = (): Promise<void> => run('stop', () => palace.stop(m.id))
  const doCmux = (): Promise<void> =>
    run('cmux', async () => {
      const r = await palace.openInCmux(m.id)
      showToast(r.message)
    })
  const copyCmd = (): Promise<void> =>
    run('copy', async () => {
      await palace.writeClipboard(`cd ${app.dir ?? ''} && ${m.start?.run ?? ''}`)
      showToast('시작 명령을 클립보드에 복사했어요')
    })

  return (
    <div className="detail">
      <div className="detail-head">
        <div className="title-row">
          <div>
            <h1>
              {m.accent && <span className="dot installed" style={{ background: m.accent, width: 10, height: 10 }} />}
              {m.name}
              {m.builtin && <span className="chip" style={{ fontSize: 10 }}>내장</span>}
            </h1>
            <p className="tagline">{m.tagline}</p>
          </div>
          <div className="title-actions">{renderActions()}</div>
        </div>

        <div className="chips">
          <span className={`chip ${installed ? 'ok' : ''}`}>{installed ? '● 설치됨' : '○ 미설치'}</span>
          <span className={`chip ${running ? 'ok' : ''}`}>
            {running ? (managed ? `▶ 실행 중 (pid ${app.pid})` : '▶ 실행 중 (cmux)') : '■ 정지'}
          </span>
          {m.dashboard?.port && (
            <span className={`chip ${app.portOpen ? 'ok' : ''}`}>
              포트 <b>{m.dashboard.port}</b> {app.portOpen ? 'open' : 'closed'}
            </span>
          )}
          {app.version && <span className="chip">v<b>{app.version}</b></span>}
          {app.git?.branch && (
            <span className="chip">
              <b>{app.git.branch}</b>@{app.git.shortSha}
              {app.git.dirty && <span className="faint"> · dirty</span>}
            </span>
          )}
          {app.git?.updateAvailable && <span className="chip warn">↑ {app.git.behind} commit 뒤처짐</span>}
          <span className="chip">{m.launchMode === 'cmux' ? 'cmux 기동' : m.launchMode === 'process' ? '직접 기동' : '수동'}</span>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'overview' ? 'active' : ''}`} onClick={() => setTab('overview')}>
          개요
        </button>
        <button className={`tab ${tab === 'dashboard' ? 'active' : ''}`} onClick={() => setTab('dashboard')}>
          대시보드
        </button>
        <button className={`tab ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>
          로그<span className="badge-count">{logs.length || ''}</span>
        </button>
        <button className={`tab ${tab === 'docs' ? 'active' : ''}`} onClick={() => setTab('docs')}>
          문서
        </button>
        {m.env && (
          <button className={`tab ${tab === 'env' ? 'active' : ''}`} onClick={() => setTab('env')}>
            환경
          </button>
        )}
        <button className={`tab ${tab === 'doctor' ? 'active' : ''}`} onClick={() => setTab('doctor')}>
          진단
        </button>
      </div>

      {tab === 'overview' && <Overview app={app} onOpenDashboard={() => setTab('dashboard')} />}
      {tab === 'dashboard' && (
        <div className="pane flush" style={{ display: 'flex' }}>
          <DashboardEmbed app={app} onStart={doStart} />
        </div>
      )}
      {tab === 'logs' && <LogsView logs={logs} />}
      {tab === 'docs' && <Docs app={app} />}
      {tab === 'env' && <EnvEditor app={app} showToast={showToast} />}
      {tab === 'doctor' && <Doctor app={app} showToast={showToast} />}
    </div>
  )

  function renderActions(): JSX.Element {
    const spin = (label: string): JSX.Element | null => (busy === label ? <span className="spin" /> : null)
    return (
      <>
        {!installed && (
          <button className="btn primary" disabled={!!busy || app.installState === 'installing'} onClick={doInstall}>
            {spin('install') || '⤓'} {app.installState === 'installing' ? '설치 중…' : '설치'}
          </button>
        )}
        {installed && !running && m.launchMode === 'process' && (
          <button className="btn green" disabled={!!busy} onClick={doStart}>
            {spin('start') || '▶'} 시작
          </button>
        )}
        {installed && !running && m.launchMode !== 'process' && (
          <>
            <button className="btn green" disabled={!!busy} onClick={doCmux}>
              {spin('cmux') || '▶'} cmux에서 실행
            </button>
            <button className="btn sm" disabled={!!busy} onClick={copyCmd}>
              명령 복사
            </button>
          </>
        )}
        {installed && running && (
          <button className="btn primary" onClick={() => setTab('dashboard')}>
            ◱ 대시보드 열기
          </button>
        )}
        {installed && running && managed && (
          <button className="btn danger" disabled={!!busy} onClick={doStop}>
            {spin('stop') || '■'} 정지
          </button>
        )}
        {installed && (
          <button
            className={`btn ${app.git?.updateAvailable ? 'primary' : ''}`}
            disabled={!!busy}
            onClick={doUpdate}
            title={app.git?.updateAvailable ? `${app.git.behind} commit 뒤처짐` : '최신 반영'}
          >
            {spin('update') || '↻'} 업데이트
          </button>
        )}
        {installed && (
          <button className="iconbtn" title="폴더 열기" onClick={() => palace.openDir(m.id)}>
            📂
          </button>
        )}
        {m.repoHttps && (
          <button className="iconbtn" title="GitHub" onClick={() => palace.openExternal(m.repoHttps!)}>
            ⌥
          </button>
        )}
      </>
    )
  }
}

function Overview({ app, onOpenDashboard }: { app: AppView; onOpenDashboard: () => void }): JSX.Element {
  const m = app.manifest
  return (
    <div className="pane">
      {m.description && (
        <div className="card">
          <h3>소개</h3>
          <div className="desc">{m.description}</div>
        </div>
      )}
      {m.notes && (
        <div className="card">
          <h3>알아둘 것</h3>
          <div className="notes">
            <span>ⓘ</span>
            <span>{m.notes}</span>
          </div>
        </div>
      )}
      <div className="card">
        <h3>빠른 정보</h3>
        <div className="desc" style={{ display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 8 }}>
          <span className="faint">런타임</span>
          <span>{m.runtime ?? '—'}</span>
          <span className="faint">저장소</span>
          <span className="mono" style={{ fontSize: 12 }}>{m.repo}</span>
          {app.dir && (
            <>
              <span className="faint">경로</span>
              <span className="mono" style={{ fontSize: 12 }}>{app.dir}</span>
            </>
          )}
          {m.dashboard && (
            <>
              <span className="faint">대시보드</span>
              <span>
                <a onClick={() => (app.runState === 'running' ? onOpenDashboard() : undefined)}>{m.dashboard.url}</a>{' '}
                {app.runState !== 'running' && <span className="faint">(실행되면 임베드)</span>}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
