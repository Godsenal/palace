import QRCode from 'qrcode'
import { useCallback, useEffect, useState } from 'react'
import { palace } from '../../api'
import type { AgentProfile, NativeOmpHost, NativeOmpLink, RemoteStatus } from '../../../../shared/workbench'
import { Modal } from '../automation/ui'
import { messageOf } from './RichText'
import { WorkbenchIcon } from './WorkbenchIcon'

type Model = { id: string; name: string; provider: string }
type Project = { name: string; path: string }
const hostTitle = (host: NativeOmpHost): string => {
  const parts = host.cwd.split('/').filter(Boolean)
  return host.sessionName || parts[parts.length - 1] || `OMP ${host.pid}`
}
const hostModel = (host: NativeOmpHost): string => host.model ? `${host.model.provider}/${host.model.id}` : 'Auto'
const startedLabel = (value: number): string => new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value < 10_000_000_000 ? value * 1000 : value))

export function RemoteView({ visible, showToast }: { visible: boolean; showToast: (message: string) => void }): JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [models, setModels] = useState<Model[]>([])
  const [profiles, setProfiles] = useState<AgentProfile[]>([])
  const [project, setProject] = useState('')
  const [model, setModel] = useState('')
  const [profileId, setProfileId] = useState('')
  const [access, setAccess] = useState<'off' | 'view' | 'control'>('off')
  const [link, setLink] = useState<NativeOmpLink | null>(null)
  const [qrData, setQrData] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await palace.remote.status())
    } catch (reason) {
      setError(messageOf(reason))
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    void load()
    void Promise.all([palace.automation.snapshot(), palace.ide.models(), palace.ide.snapshot()]).then(([automation, availableModels, ide]) => {
      const availableProjects = Object.entries(automation.settings.projectPaths).map(([name, path]) => ({ name, path }))
      setProjects(availableProjects)
      setProject((current) => current || availableProjects[0]?.name || '')
      setModels(availableModels)
      setProfiles(ide.profiles)
    }).catch((reason) => setError(messageOf(reason)))
    const timer = window.setInterval(() => void load(), 3000)
    return () => window.clearInterval(timer)
  }, [visible, load])

  useEffect(() => {
    if (!link) { setQrData(''); return }
    QRCode.toDataURL(link.url, { width: 260, margin: 2, color: { dark: '#101217', light: '#ffffff' }, errorCorrectionLevel: 'M' }).then(setQrData).catch((reason) => setError(messageOf(reason)))
  }, [link])

  const launch = async (): Promise<void> => {
    if (!project) return
    setBusy('launch'); setError(null)
    try {
      const result = await palace.remote.launch({ project, model: model || undefined, profileId: profileId || undefined, access })
      showToast(result.message || 'cmux에서 OMP 개발 세션을 시작했습니다')
      await load()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setBusy(null)
    }
  }

  const createLink = async (host: NativeOmpHost, requested: 'view' | 'control'): Promise<void> => {
    setBusy(`${host.instanceId}:${requested}`); setError(null); setLink(null)
    try {
      setLink(await palace.remote.link(host.instanceId, host.generation, requested))
    } catch (reason) {
      const raw = messageOf(reason)
      setError(/stale_generation|stale generation|세대/i.test(raw) ? 'OMP 세션이 전환되어 이전 세대의 링크를 만들 수 없습니다. 목록을 새로고친 뒤 현재 세션에서 다시 시도하세요.' : raw)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const focus = async (workspaceRef: string): Promise<void> => {
    setBusy(`focus:${workspaceRef}`); setError(null)
    try { await palace.remote.focus(workspaceRef); showToast('cmux 워크스페이스로 이동했습니다') }
    catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  const copyLink = async (): Promise<void> => {
    if (!link) return
    try { await navigator.clipboard.writeText(link.url); showToast(`${link.access === 'control' ? '제어' : '보기 전용'} 링크를 복사했습니다`) }
    catch (reason) { setError(messageOf(reason)) }
  }

  return <section className="wb-page wb-native-remote" hidden={!visible} aria-labelledby="remote-title">
    <header className="wb-page-header wb-native-header"><div><span className="wb-eyebrow">PRIMARY DEVELOPMENT ENVIRONMENT</span><h1 id="remote-title">cmux + OMP</h1><p>실제 개발은 cmux의 네이티브 OMP TUI에서 실행하고, 필요할 때 OMP 세션 자체를 휴대폰에 안전하게 공유합니다.</p></div><span className={`wb-connection-state ${status?.available && status.cmuxAvailable ? 'is-on' : ''}`}><span />{!status ? '확인 중' : status.available && status.cmuxAvailable ? '개발 환경 준비됨' : '설정 필요'}</span></header>
    {error && <div className="wb-error" role="alert"><WorkbenchIcon name="warning" /><span>{error}</span><button type="button" aria-label="오류 닫기" onClick={() => setError(null)}><WorkbenchIcon name="close" size={14} /></button></div>}

    <section className="wb-native-launch wb-surface">
      <div className="wb-section-head"><div><span className="wb-eyebrow">NEW NATIVE SESSION</span><h2>cmux에서 개발 시작</h2><p>프로젝트와 모델을 고르면 Palace가 새 cmux 워크스페이스에서 실제 OMP를 시작합니다.</p></div><span className="wb-native-badge"><WorkbenchIcon name="terminal" size={14} /> Native TUI</span></div>
      <div className="wb-native-launch-grid">
        <label><span>프로젝트</span><select value={project} onChange={(event) => setProject(event.target.value)}><option value="">프로젝트 선택</option>{projects.map((item) => <option value={item.name} key={item.name}>{item.name}</option>)}</select>{project && <small>{projects.find((item) => item.name === project)?.path}</small>}</label>
        <label><span>모델</span><select value={model} onChange={(event) => setModel(event.target.value)}><option value="">Auto · OMP 기본값</option>{models.map((item) => <option value={`${item.provider}/${item.id}`} key={`${item.provider}/${item.id}`}>{item.name} · {item.provider}</option>)}</select></label>
        <label><span>전문 프로필</span><select value={profileId} onChange={(event) => setProfileId(event.target.value)}><option value="">프로필 없음</option>{profiles.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <label><span>시작 시 공유</span><select value={access} onChange={(event) => setAccess(event.target.value as 'off' | 'view' | 'control')}><option value="off">공유 안 함</option><option value="view">보기 전용 · 진행 확인</option><option value="control">제어 허용 · 휴대폰 개입</option></select><small>나중에 OMP에서 /collab 또는 /collab view를 실행할 수도 있습니다.</small></label>
      </div>
      <div className="wb-native-launch-actions"><div><strong>Palace 안의 Workbench는 보조 도구입니다.</strong><span>주 개발 흐름은 cmux 터미널과 OMP의 전체 TUI, 도구, 서브에이전트를 그대로 사용합니다.</span></div><button className="wb-button wb-button--primary" type="button" disabled={!project || busy === 'launch' || !status?.available || !status.cmuxAvailable} onClick={() => void launch()}><WorkbenchIcon name="play" /> {busy === 'launch' ? 'cmux에서 시작 중…' : 'cmux + OMP 시작'}</button></div>
    </section>

    {status?.message && <div className="wb-warning-box"><WorkbenchIcon name="warning" /><div><strong>네이티브 환경 상태</strong><p>{status.message}</p></div></div>}

    <div className="wb-section-head wb-native-hosts-head"><div><span className="wb-eyebrow">LIVE OMP COLLAB</span><h2>공유 중인 OMP 세션</h2><p>목록에는 비밀 링크가 포함되지 않습니다. 각 세션에서 명시적으로 링크를 만들 때만 URL이 발급됩니다.</p></div><button className="wb-icon-button" type="button" aria-label="OMP 세션 목록 새로고침" onClick={() => void load()}><WorkbenchIcon name="refresh" /></button></div>
    {!status ? <div className="wb-loading"><span className="spin" /> 네이티브 OMP 세션 확인 중</div> : <div className="wb-native-host-list">
      {status.hosts.map((host) => <article className={`wb-native-host wb-surface ${host.inputRequired ? 'is-input-required' : ''}`} key={`${host.instanceId}:${host.generation}`}>
        <div className="wb-native-host-main"><span className="wb-host-icon"><WorkbenchIcon name="agent" /></span><div><div className="wb-host-title"><strong>{hostTitle(host)}</strong>{host.inputRequired && <span className="wb-input-required">응답 필요</span>}</div><code>{host.cwd}</code><div className="wb-host-meta"><span>{hostModel(host)}</span><span>PID {host.pid}</span><span>{startedLabel(host.startedAt)}</span><span>{host.participants}명 참여</span></div></div></div>
        <div className="wb-host-health"><span className={host.relayConnected ? 'is-good' : 'is-bad'}><i />{host.relayConnected ? 'E2E 릴레이 연결됨' : '릴레이 연결 끊김'}</span><span>{host.access === 'control' ? '보기·제어 링크 허용' : '보기 전용 호스트'}</span></div>
        <div className="wb-host-actions">{host.workspaceRef && <button className="wb-button" type="button" disabled={busy === `focus:${host.workspaceRef}`} onClick={() => void focus(host.workspaceRef!)}><WorkbenchIcon name="external" size={14} /> cmux로 이동</button>}<button className="wb-button" type="button" disabled={!!busy || !host.relayConnected} onClick={() => void createLink(host, 'view')}><WorkbenchIcon name="files" size={14} /> 보기 링크</button>{host.access === 'control' && <button className="wb-button wb-button--primary" type="button" disabled={!!busy || !host.relayConnected} onClick={() => void createLink(host, 'control')}><WorkbenchIcon name="remote" size={14} /> 제어 링크</button>}</div>
      </article>)}
      {status.hosts.length === 0 && <div className="wb-native-empty"><WorkbenchIcon name="remote" size={28} /><h3>공유 중인 OMP 세션이 없습니다</h3><p>위에서 공유 수준을 선택해 새 세션을 시작하거나, 기존 OMP에서 <code>/collab</code> 또는 <code>/collab view</code>를 실행하세요.</p></div>}
    </div>}

    {!!status?.workspaces.length && <section className="wb-surface wb-cmux-workspaces"><div className="wb-section-head"><div><h2>cmux 워크스페이스</h2><p>현재 cmux에서 열린 개발 공간으로 바로 이동합니다.</p></div><span>{status.workspaces.length}개</span></div><div>{status.workspaces.map((workspace) => <button type="button" onClick={() => void focus(workspace.ref)} key={workspace.ref}><span><strong>{workspace.title}</strong><small>{workspace.cwd}</small></span><WorkbenchIcon name="external" size={14} /></button>)}</div></section>}

    <div className="wb-native-explainer"><WorkbenchIcon name="check" size={18} /><div><strong>Palace 게이트웨이가 아니라 OMP 네이티브 Collab입니다.</strong><p><code>https://my.omp.sh/#…</code> 링크의 키는 URL fragment에만 있으며, 세션 내용은 AES-256-GCM으로 종단간 암호화됩니다. Tailscale은 필요하지 않습니다. 제어 링크 소유자는 프롬프트·중단·서브에이전트 제어가 가능하므로 비밀처럼 다루세요. 공유 종료와 즉시 폐기는 실제 OMP TUI에서 <code>/collab stop</code>을 실행합니다.</p></div></div>

    {link && <Modal title={link.access === 'control' ? 'OMP 제어 링크' : 'OMP 보기 전용 링크'} description={link.access === 'control' ? '휴대폰에서 프롬프트, 중단과 서브에이전트 제어가 가능합니다.' : '세션을 실시간으로 볼 수 있지만 변경하거나 제어할 수 없습니다.'} onClose={() => setLink(null)} width="medium" footer={<><button className="auto-button" type="button" onClick={() => setLink(null)}>닫기</button><button className="auto-button auto-button--primary" type="button" onClick={() => void palace.openExternal(link.url)}>브라우저에서 열기</button></>}>
      <div className="wb-pairing"><div className="wb-qr-frame">{qrData ? <img src={qrData} alt={`${link.access === 'control' ? '제어' : '보기 전용'} OMP Collab QR 코드`} /> : <span className="spin" />}</div><p>휴대폰 카메라로 스캔하면 OMP 웹 클라이언트에서 이 세션에 직접 연결됩니다.</p><div className="wb-copy-row"><input readOnly value={link.url} /><button className="wb-button" type="button" onClick={() => void copyLink()}><WorkbenchIcon name="copy" size={14} /> 복사</button></div><div className="wb-warning-box"><WorkbenchIcon name="warning" /><div><strong>{link.access === 'control' ? '이 링크는 원격 제어 비밀입니다' : '이 링크도 전체 대화를 읽을 수 있습니다'}</strong><p>URL fragment의 키를 가진 사람은 이 세션에 접근할 수 있습니다. 채팅, 이슈, 로그에 붙여 넣지 마세요.</p></div></div></div>
    </Modal>}
  </section>
}
