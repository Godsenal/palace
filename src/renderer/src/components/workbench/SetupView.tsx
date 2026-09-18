import { useCallback, useEffect, useState } from 'react'
import { palace } from '../../api'
import type { SetupStatus } from '../../../../shared/workbench'
import type { MachineSettings } from '../../../../shared/automation'
import { messageOf } from './RichText'
import { WorkbenchIcon } from './WorkbenchIcon'

type Repository = { name: string; url: string; private: boolean }
type Installable = 'omp' | 'gh' | 'cmux' | 'tailscale' | 'bun' | 'node' | 'git'
type LoginTool = 'omp' | 'gh' | 'tailscale'

export function SetupView({ visible, showToast }: { visible: boolean; showToast: (message: string) => void }): JSX.Element {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('main')
  const [machine, setMachine] = useState<MachineSettings | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await palace.setup.status(); setStatus(next); setError(null)
      const gh = next.tools.find((tool) => tool.id === 'gh')
      if (gh?.authenticated) setRepositories(await palace.setup.repositories())
      const automation = await palace.automation.snapshot().catch(() => null)
      if (automation) { setMachine(automation.settings); setRepo(automation.settings.syncRemote); setBranch(automation.settings.syncBranch) }
    } catch (reason) { setError(messageOf(reason)) }
  }, [])
  useEffect(() => { if (visible) void load() }, [visible, load])

  const install = async (tool: Installable): Promise<void> => {
    setBusy(`install:${tool}`); setError(null)
    try { setStatus(await palace.setup.install(tool)); showToast('설치 작업을 마쳤습니다') }
    catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }
  const login = async (tool: LoginTool): Promise<void> => {
    setBusy(`login:${tool}`); setError(null)
    try { const result = await palace.setup.login(tool); showToast(result.message); await load() }
    catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }
  const addProject = async (): Promise<void> => {
    setBusy('project'); setError(null)
    try { const chosen = await palace.setup.chooseProject(); if (chosen) { showToast(`${chosen.name} 프로젝트를 감지 목록에 추가했습니다`); await load() } }
    catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }
  const saveRepository = async (): Promise<void> => {
    if (!machine || !repo || !branch.trim()) return
    setBusy('repository'); setError(null)
    try { const next = await palace.automation.saveSettings({ ...machine, syncRemote: repo, syncBranch: branch.trim() }); setMachine(next.settings); showToast('프로필 Git 저장소를 연결했습니다') }
    catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  const required = status?.tools.filter((tool) => !tool.optional) ?? []
  const ready = required.filter((tool) => tool.available && tool.authenticated !== false).length
  return <section className="wb-page" hidden={!visible} aria-labelledby="setup-title">
    <header className="wb-page-header">
      <div><span className="wb-eyebrow">NEW COMPUTER</span><h1 id="setup-title">Setup</h1><p>새 컴퓨터에서도 OMP, 프로젝트와 Palace 프로필을 선택 중심 흐름으로 준비합니다.</p></div>
      {status && <div className="wb-setup-progress"><strong>{ready}/{required.length}</strong><span>필수 도구 준비됨</span></div>}
    </header>
    {error && <div className="wb-error" role="alert"><WorkbenchIcon name="warning" /><span>{error}</span><button type="button" onClick={() => setError(null)}><WorkbenchIcon name="close" size={14} /></button></div>}
    {!status ? <div className="wb-loading"><span className="spin" /> 이 컴퓨터 확인 중</div> : <>
      <section className="wb-setup-grid">
        {status.tools.map((tool) => {
          const needsLogin = tool.available && tool.authenticated === false && (tool.id === 'omp' || tool.id === 'gh' || tool.id === 'tailscale')
          return <article className={`wb-tool-card ${tool.available && !needsLogin ? 'is-ready' : ''}`} key={tool.id}>
            <div className="wb-tool-card__head"><span><WorkbenchIcon name={tool.id === 'tailscale' ? 'remote' : tool.id === 'omp' ? 'agent' : tool.id === 'gh' ? 'branch' : 'tools'} /></span><span className={`wb-state-label ${tool.available && !needsLogin ? 'is-good' : needsLogin ? 'is-warn' : ''}`}>{!tool.available ? tool.optional ? '선택 사항' : '설치 필요' : needsLogin ? '로그인 필요' : '준비됨'}</span></div>
            <h2>{tool.name}</h2><p>{tool.message}</p>
            {!tool.available ? <button className="wb-button wb-button--primary" type="button" disabled={!!busy} onClick={() => void install(tool.id as Installable)}>{busy === `install:${tool.id}` ? '설치 중…' : '설치'}</button> : needsLogin ? <button className="wb-button wb-button--primary" type="button" disabled={!!busy} onClick={() => void login(tool.id as LoginTool)}>{busy === `login:${tool.id}` ? '로그인 여는 중…' : '로그인'}</button> : <span className="wb-ready-copy"><WorkbenchIcon name="check" size={14} /> 사용 가능</span>}
          </article>
        })}
      </section>
      <div className="wb-setup-columns">
        <section className="wb-surface">
          <div className="wb-section-head"><div><h2>프로젝트</h2><p>코드 경로를 직접 입력하지 않고 폴더에서 선택합니다.</p></div><button className="wb-button" type="button" disabled={busy === 'project'} onClick={() => void addProject()}><WorkbenchIcon name="plus" size={14} /> 프로젝트 선택</button></div>
          <div className="wb-detected-projects">{status.projects.map((project) => <div key={project.path}><span className="wb-project-glyph">{project.name.slice(0, 1).toUpperCase()}</span><span><strong>{project.name}</strong><small>{project.path}</small></span><WorkbenchIcon name="check" size={15} /></div>)}{status.projects.length === 0 && <div className="wb-panel-empty">감지된 프로젝트가 없습니다. 폴더를 선택해 추가하세요.</div>}</div>
        </section>
        <section className="wb-surface">
          <div className="wb-section-head"><div><h2>프로필 Git 저장소</h2><p>OMP 설정, 지침, Skills와 자동화를 컴퓨터 사이에 동기화합니다.</p></div></div>
          {repositories.length > 0 ? <div className="wb-repository-form"><label><span>저장소</span><select value={repo} onChange={(event) => setRepo(event.target.value)}><option value="">저장소 선택</option>{repositories.map((item) => <option value={item.url} key={item.url}>{item.name}{item.private ? ' · Private' : ''}</option>)}</select></label><label><span>Branch</span><select value={branch} onChange={(event) => setBranch(event.target.value)}><option value="main">main</option><option value="master">master</option><option value="profile">profile</option></select></label><button className="wb-button wb-button--primary" type="button" disabled={!repo || !machine || busy === 'repository'} onClick={() => void saveRepository()}>{busy === 'repository' ? '연결 중…' : '저장소 연결'}</button></div> : <div className="wb-auth-instruction"><WorkbenchIcon name="branch" /><div><strong>GitHub 로그인이 필요합니다</strong><p>저장소 목록을 안전하게 불러오려면 위의 GitHub 카드에서 로그인하세요. 브라우저나 터미널에 표시되는 GitHub 인증 단계는 외부 서비스에서 직접 완료해야 합니다.</p></div></div>}
        </section>
      </div>
    </>}
  </section>
}
