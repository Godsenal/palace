import { useCallback, useEffect, useState, type FC } from 'react'
import { palace } from '../../api'
import type { EngineStatus } from '../../../../shared/workbench'
import { messageOf } from './RichText'
import { WorkbenchIcon } from './WorkbenchIcon'
const WebView = 'webview' as unknown as FC<{ className: string; src: string; allowpopups: string }>


export function LoopsView({ visible }: { visible: boolean }): JSX.Element {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async (): Promise<void> => {
    try { setStatus(await palace.loops.status()); setError(null) }
    catch (reason) { setError(messageOf(reason)) }
  }, [])
  useEffect(() => { if (visible) void load() }, [visible, load])
  const start = async (): Promise<void> => {
    setBusy(true); setError(null)
    try { setStatus(await palace.loops.start()) }
    catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(false) }
  }
  const stop = async (): Promise<void> => {
    setBusy(true); setError(null)
    try { await palace.loops.stop(); await load() }
    catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(false) }
  }
  const frameUrl = status?.running ? status.url : undefined
  return <section className="wb-loops-view" hidden={!visible} aria-label="Autonomous Loops">
    <header className="wb-engine-bar"><div><span className="wb-eyebrow">AUTONOMOUS ENGINE</span><h1>Loops</h1></div>{status && <div className="wb-engine-status"><span className={status.running ? 'is-on' : ''} /><strong>{status.running ? '엔진 실행 중' : status.available ? '엔진 정지됨' : '설치 필요'}</strong></div>}<div className="wb-engine-actions"><button className="wb-icon-button" type="button" aria-label="상태 새로고침" onClick={() => void load()}><WorkbenchIcon name="refresh" /></button>{status?.running ? <button className="wb-button is-danger" type="button" disabled={busy} onClick={() => void stop()}><WorkbenchIcon name="stop" size={14} /> 엔진 중지</button> : <button className="wb-button wb-button--primary" type="button" disabled={busy || !status?.available} onClick={() => void start()}><WorkbenchIcon name="play" size={14} /> {busy ? '시작 중…' : 'Loops 시작'}</button>}</div></header>
    {error && <div className="wb-error" role="alert"><WorkbenchIcon name="warning" /><span>{error}</span><button type="button" onClick={() => setError(null)}><WorkbenchIcon name="close" size={14} /></button></div>}
    {!status ? <div className="wb-loading"><span className="spin" /> Loops 엔진 확인 중</div> : frameUrl ? <WebView className="wb-engine-frame" src={frameUrl} allowpopups="true" /> : <div className="wb-engine-empty"><div className="wb-engine-empty__mark"><WorkbenchIcon name="loop" size={30} /></div><h2>{status.available ? 'Loops 엔진이 준비되었습니다' : 'Loops 엔진을 시작할 수 없습니다'}</h2><p>{status.message || (status.available ? '기존 Godsenal Loops의 전체 대시보드와 자율 실행 기능을 그대로 엽니다.' : '아래 필수 조건을 먼저 준비하세요.')}</p><div className="wb-prereq-list">{status.prerequisites.map((item) => <div className={item.available ? 'is-ready' : 'is-missing'} key={item.name}><WorkbenchIcon name={item.available ? 'check' : 'warning'} size={15} /><span><strong>{item.name}</strong><small>{item.message || (item.available ? '준비됨' : '설치 또는 로그인이 필요합니다')}</small></span></div>)}</div>{status.available && <button className="wb-button wb-button--primary" type="button" disabled={busy} onClick={() => void start()}><WorkbenchIcon name="play" /> {busy ? '엔진 시작 중…' : '전체 Loops 대시보드 열기'}</button>}</div>}
  </section>
}
