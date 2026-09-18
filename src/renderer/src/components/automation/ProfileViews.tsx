import { useEffect, useMemo, useState } from 'react'
import { palace } from '../../api'
import type { AutomationSnapshot, MachineSettings, PortableProfile, ServiceStatus } from '../../../../shared/automation'
import { BusyLabel, Icon, InlineError, Modal, formatTime } from './ui'

interface Props {
  snapshot: AutomationSnapshot
  onSnapshot: (snapshot: AutomationSnapshot) => void
  showToast: (message: string) => void
}

interface SkillDraft { path: string; content: string }

export function OmpSyncView({ snapshot, onSnapshot, showToast }: Props): JSX.Element {
  const [config, setConfig] = useState('')
  const [instructions, setInstructions] = useState('')
  const [skills, setSkills] = useState<SkillDraft[]>([])
  const [remote, setRemote] = useState('')
  const [branch, setBranch] = useState('')
  const [repositories, setRepositories] = useState<Array<{ name: string; url: string; private: boolean }>>([])
  const [profileDirty, setProfileDirty] = useState(false)
  const [connectionDirty, setConnectionDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmImport, setConfirmImport] = useState(false)
  const [confirmSync, setConfirmSync] = useState<'push' | 'pull' | null>(null)
  const [showAdvancedConfig, setShowAdvancedConfig] = useState(false)
  const [models, setModels] = useState<Array<{ id: string; name: string; provider: string }>>([])

  useEffect(() => { palace.ide.models().then(setModels).catch(() => setModels([])) }, [])
  useEffect(() => { palace.setup.repositories().then(setRepositories).catch(() => setRepositories([])) }, [])

  const commonConfig = useMemo(() => {
    try {
      const parsed = JSON.parse(config) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { model: '', advisor: 'custom', prewalk: 'custom' }
      const record = parsed as Record<string, unknown>
      return {
        model: typeof record.model === 'string' ? record.model : '',
        advisor: record.advisor === true ? 'enabled' : record.advisor === false ? 'disabled' : record.advisor === undefined ? 'auto' : 'custom',
        prewalk: record.prewalk === true ? 'enabled' : record.prewalk === false ? 'disabled' : record.prewalk === undefined ? 'auto' : 'custom'
      }
    } catch {
      return { model: '', advisor: 'custom', prewalk: 'custom' }
    }
  }, [config])

  const updateCommonConfig = (key: 'model' | 'advisor' | 'prewalk', value: string): void => {
    try {
      const parsed = JSON.parse(config) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Config must be an object')
      const record = parsed as Record<string, unknown>
      if (key === 'model') {
        if (value) record.model = value
        else delete record.model
      } else if (value === 'auto') delete record[key]
      else record[key] = value === 'enabled'
      setConfig(JSON.stringify(record, null, 2))
      setProfileDirty(true)
      setError(null)
    } catch {
      setError('고급 Config JSON을 먼저 올바른 객체로 수정하세요.')
    }
  }

  useEffect(() => {
    if (profileDirty) return
    setConfig(JSON.stringify(snapshot.profile.omp.config, null, 2))
    setInstructions(snapshot.profile.omp.instructions)
    setSkills(Object.entries(snapshot.profile.omp.skills).map(([path, content]) => ({ path, content })))
  }, [snapshot.profile.omp, profileDirty])

  useEffect(() => {
    if (connectionDirty) return
    setRemote(snapshot.settings.syncRemote)
    setBranch(snapshot.settings.syncBranch)
  }, [snapshot.settings.syncRemote, snapshot.settings.syncBranch, connectionDirty])

  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent): void => {
      if (!profileDirty && !connectionDirty) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [profileDirty, connectionDirty])

  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key); setError(null)
    try { await fn() }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(null) }
  }

  const saveProfile = (): Promise<void> => run('profile', async () => {
    let parsed: unknown
    try { parsed = JSON.parse(config) }
    catch (reason) { throw new Error(`Config JSON 형식이 올바르지 않습니다: ${reason instanceof Error ? reason.message : String(reason)}`) }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Config JSON의 최상위 값은 객체여야 합니다.')
    const skillRecord: Record<string, string> = {}
    for (const skill of skills) {
      const path = skill.path.trim()
      if (!path) throw new Error('모든 Skill에 경로가 필요합니다.')
      if (skillRecord[path] !== undefined) throw new Error(`중복 Skill 경로: ${path}`)
      skillRecord[path] = skill.content
    }
    const omp: PortableProfile['omp'] = { config: parsed as Record<string, unknown>, instructions, skills: skillRecord }
    const next = await palace.automation.saveOmp(omp)
    onSnapshot(next)
    setProfileDirty(false)
    showToast('이식 가능한 OMP 구성을 저장했습니다')
  })

  const saveConnection = (): Promise<void> => run('connection', async () => {
    if (!remote.trim()) throw new Error('Git remote를 입력하세요.')
    if (!branch.trim()) throw new Error('동기화 branch를 입력하세요.')
    const next = await palace.automation.saveSettings({ ...snapshot.settings, syncRemote: remote.trim(), syncBranch: branch.trim() })
    onSnapshot(next)
    setConnectionDirty(false)
    showToast('동기화 대상을 저장했습니다')
  })

  const importLocal = (): Promise<void> => run('import', async () => {
    const next = await palace.automation.importOmp()
    onSnapshot(next)
    setProfileDirty(false)
    setConfirmImport(false)
    showToast('로컬 OMP 구성을 가져왔습니다')
  })

  const sync = (direction: 'push' | 'pull'): Promise<void> => run(`sync:${direction}`, async () => {
    const next = await palace.automation.sync(direction)
    onSnapshot(next)
    setConfirmSync(null)
    if (direction === 'pull') setProfileDirty(false)
    showToast(direction === 'push' ? '원격 저장소로 푸시했습니다' : '원격 저장소에서 가져왔습니다')
  })

  const requestSync = (direction: 'push' | 'pull'): void => {
    if (profileDirty || connectionDirty) {
      setError('저장하지 않은 변경이 있습니다. 먼저 OMP 구성과 동기화 대상을 저장하세요.')
      return
    }
    setConfirmSync(direction)
  }

  return <section className="auto-page" aria-labelledby="sync-title">
    <header className="auto-page__header">
      <div><div className="auto-eyebrow">이식 가능한 프로필</div><h1 id="sync-title">OMP Sync</h1><p>OMP 설정과 지침, Skill, 자동화 정의를 Git으로 머신 사이에 동기화합니다.</p></div>
      <div className="auto-header-actions">
        <button className="auto-button" type="button" disabled={!!busy} onClick={() => profileDirty ? setConfirmImport(true) : void importLocal()}>{busy === 'import' ? <BusyLabel label="가져오는 중" /> : <><Icon name="download" /> 로컬 OMP 가져오기</>}</button>
        <button className="auto-button auto-button--primary" type="button" disabled={!!busy || !profileDirty} onClick={() => void saveProfile()}>{busy === 'profile' ? <BusyLabel label="저장 중" /> : <><Icon name="save" /> 구성 저장</>}</button>
      </div>
    </header>
    {error && <InlineError>{error}</InlineError>}

    <div className="auto-disclosure"><Icon name="warning" /><div><strong>의도적으로 제외되는 항목</strong><p>인증 정보, MCP 서버의 비밀값, 머신의 로컬 절대 경로는 동기화하지 않습니다. 각 머신에서 OMP와 연동 서비스에 별도로 로그인해야 합니다.</p></div></div>

    <div className="auto-two-column">
      <div className="auto-panel">
        <div className="auto-panel__head"><div><h2>Git 동기화</h2><p>현재 머신의 프로필 저장소</p></div><span className={`auto-status ${snapshot.sync.connected ? 'auto-status--good' : 'auto-status--bad'}`}>{snapshot.sync.connected ? '연결됨' : '연결 안 됨'}</span></div>
        <div className="auto-form-grid">
          <label className="auto-field auto-field--wide"><span>저장소</span><select value={remote} onChange={(event) => { setRemote(event.target.value); setConnectionDirty(true) }}><option value="">Git 저장소 선택</option>{remote && !repositories.some((repository) => repository.url === remote) && <option value={remote}>{remote}</option>}{repositories.map((repository) => <option value={repository.url} key={repository.url}>{repository.name}{repository.private ? ' · Private' : ''}</option>)}</select><small>GitHub 로그인이 완료된 계정의 저장소입니다.</small></label>
          <label className="auto-field"><span>Branch</span><select value={branch} onChange={(event) => { setBranch(event.target.value); setConnectionDirty(true) }}><option value="main">main</option><option value="master">master</option><option value="profile">profile</option>{branch && !['main', 'master', 'profile'].includes(branch) && <option value={branch}>{branch}</option>}</select></label>
          <div className="auto-field auto-field--button"><span>&nbsp;</span><button className="auto-button" type="button" disabled={!!busy || !connectionDirty} onClick={() => void saveConnection()}>{busy === 'connection' ? <BusyLabel label="저장 중" /> : '대상 저장'}</button></div>
        </div>
        <dl className="auto-sync-facts"><div><dt>상태</dt><dd>{snapshot.sync.message || (snapshot.sync.connected ? '원격 저장소를 사용할 수 있습니다.' : '동기화 대상을 확인하세요.')}</dd></div><div><dt>마지막 동기화</dt><dd>{formatTime(snapshot.sync.lastSync)}</dd></div><div><dt>로컬 변경</dt><dd>{snapshot.sync.dirty ? '커밋되지 않은 변경 있음' : '깨끗함'}</dd></div></dl>
        <div className="auto-split-actions"><button className="auto-button" type="button" disabled={!!busy || !snapshot.sync.connected} onClick={() => requestSync('pull')}><Icon name="download" /> Pull</button><button className="auto-button" type="button" disabled={!!busy || !snapshot.sync.connected} onClick={() => requestSync('push')}><Icon name="upload" /> Push</button></div>
      </div>
      <div className="auto-panel">
        <div className="auto-panel__head"><div><h2>프로필 범위</h2><p>Git에 저장될 이식 가능한 데이터</p></div><span className="auto-pill">v{snapshot.profile.version}</span></div>
        <ul className="auto-scope-list"><li><Icon name="check" /><span><strong>OMP 구성과 Instructions</strong><small>민감 정보가 제거된 portable profile</small></span></li><li><Icon name="check" /><span><strong>Skills</strong><small>{skills.length}개 path/content 항목</small></span></li><li><Icon name="check" /><span><strong>Automation 정의</strong><small>{snapshot.profile.loops.length}개 루프, 머신 승인 제외</small></span></li></ul>
      </div>
    </div>

    <div className="auto-panel auto-editor-panel">
      <div className="auto-panel__head"><div><h2>OMP 기본 동작</h2><p>자주 사용하는 옵션은 선택하고, 나머지만 고급 JSON에서 관리합니다.</p></div>{profileDirty && <span className="auto-unsaved">저장하지 않음</span>}</div>
      <div className="auto-form-grid">
        <label className="auto-field"><span>기본 모델</span><select value={commonConfig.model} onChange={(event) => updateCommonConfig('model', event.target.value)}><option value="">Auto · OMP 기본값</option>{commonConfig.model && !models.some((model) => `${model.provider}/${model.id}` === commonConfig.model) && <option value={commonConfig.model}>{commonConfig.model} · 기존 설정</option>}{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}</select></label>
        <label className="auto-field"><span>Advisor</span><select value={commonConfig.advisor} onChange={(event) => updateCommonConfig('advisor', event.target.value)}>{commonConfig.advisor === 'custom' && <option value="custom" disabled>고급 설정 사용 중</option>}<option value="auto">Auto</option><option value="enabled">사용</option><option value="disabled">사용 안 함</option></select></label>
        <label className="auto-field"><span>Prewalk</span><select value={commonConfig.prewalk} onChange={(event) => updateCommonConfig('prewalk', event.target.value)}>{commonConfig.prewalk === 'custom' && <option value="custom" disabled>고급 설정 사용 중</option>}<option value="auto">Auto</option><option value="enabled">사용</option><option value="disabled">사용 안 함</option></select></label>
        <div className="auto-field"><span>고급 구성</span><button className="auto-button" type="button" aria-expanded={showAdvancedConfig} onClick={() => setShowAdvancedConfig((value) => !value)}><Icon name="chevron" /> {showAdvancedConfig ? 'JSON 닫기' : '전체 JSON 편집'}</button></div>
      </div>
      {showAdvancedConfig && <label className="auto-field"><span>OMP Config JSON</span><textarea className="auto-code-editor" rows={14} spellCheck={false} value={config} onChange={(event) => { setConfig(event.target.value); setProfileDirty(true) }} /></label>}
    </div>

    <div className="auto-panel auto-editor-panel">
      <div className="auto-panel__head"><div><h2>Instructions</h2><p>모든 OMP 세션에 적용할 이식 가능한 지침</p></div></div>
      <label className="auto-field"><span className="sr-only">OMP Instructions</span><textarea className="auto-code-editor" rows={10} value={instructions} onChange={(event) => { setInstructions(event.target.value); setProfileDirty(true) }} /></label>
    </div>

    <div className="auto-panel auto-editor-panel">
      <div className="auto-panel__head"><div><h2>Skills</h2><p>상대 경로와 파일 내용을 함께 저장합니다.</p></div><button className="auto-button" type="button" onClick={() => { setSkills((current) => [...current, { path: '', content: '' }]); setProfileDirty(true) }}><Icon name="plus" /> Skill 추가</button></div>
      {skills.length === 0 ? <div className="auto-compact-empty">동기화할 Skill이 없습니다.</div> : <div className="auto-skill-list">{skills.map((skill, index) => <div className="auto-skill" key={index}><div className="auto-skill__head"><label className="auto-field"><span>상대 경로</span><input className="auto-mono" value={skill.path} onChange={(event) => { setSkills((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, path: event.target.value } : item)); setProfileDirty(true) }} /></label><button className="auto-icon-button" type="button" aria-label={`Skill ${index + 1} 삭제`} onClick={() => { setSkills((current) => current.filter((_, itemIndex) => itemIndex !== index)); setProfileDirty(true) }}><Icon name="trash" /></button></div><label className="auto-field"><span>내용</span><textarea className="auto-code-editor" rows={8} value={skill.content} onChange={(event) => { setSkills((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, content: event.target.value } : item)); setProfileDirty(true) }} /></label></div>)}</div>}
    </div>

    {confirmImport && <Modal title="저장하지 않은 변경 버리기" description="로컬 OMP 가져오기는 현재 편집 중인 내용을 교체합니다." onClose={() => setConfirmImport(false)} width="small" footer={<><button className="auto-button" type="button" onClick={() => setConfirmImport(false)}>돌아가기</button><button className="auto-button auto-button--danger" type="button" disabled={!!busy} onClick={() => void importLocal()}>{busy === 'import' ? <BusyLabel label="가져오는 중" /> : '버리고 가져오기'}</button></>}><p>저장하지 않은 Config, Instructions, Skill 변경을 버립니다.</p></Modal>}
    {confirmSync && <Modal title={confirmSync === 'push' ? '원격으로 Push' : '원격에서 Pull'} description={`${snapshot.settings.syncRemote} · ${snapshot.settings.syncBranch}`} onClose={() => setConfirmSync(null)} width="small" footer={<><button className="auto-button" type="button" onClick={() => setConfirmSync(null)}>취소</button><button className={`auto-button ${confirmSync === 'pull' ? 'auto-button--danger' : 'auto-button--primary'}`} type="button" disabled={!!busy} onClick={() => void sync(confirmSync)}>{busy === `sync:${confirmSync}` ? <BusyLabel label="동기화 중" /> : confirmSync === 'push' ? 'Push 실행' : 'Pull 실행'}</button></>}><p>{confirmSync === 'push' ? '저장된 로컬 프로필과 자동화 정의를 원격 branch에 반영합니다.' : '원격 프로필과 자동화 정의로 이 머신의 portable profile을 교체합니다. 머신별 경로와 승인은 유지됩니다.'}</p></Modal>}
  </section>
}

export function MachineView({ snapshot, onSnapshot, showToast }: Props): JSX.Element {
  const [draft, setDraft] = useState<MachineSettings>(() => structuredClone(snapshot.settings))
  const [paths, setPaths] = useState(() => Object.entries(snapshot.settings.projectPaths).map(([alias, path]) => ({ alias, path })))
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [service, setService] = useState<ServiceStatus | null>(null)
  const [serviceLoading, setServiceLoading] = useState(true)
  const [showAdvancedRuntime, setShowAdvancedRuntime] = useState(false)

  useEffect(() => {
    if (dirty) return
    setDraft(structuredClone(snapshot.settings))
    setPaths(Object.entries(snapshot.settings.projectPaths).map(([alias, path]) => ({ alias, path })))
  }, [snapshot.settings, dirty])

  const serviceAction = async (action: 'status' | 'install' | 'uninstall'): Promise<void> => {
    setBusy(`service:${action}`); setError(null); setServiceLoading(true)
    try {
      const next = await palace.automation.service(action)
      setService(next)
      if (action !== 'status') showToast(action === 'install' ? '백그라운드 서비스를 설치했습니다' : '백그라운드 서비스를 제거했습니다')
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(null); setServiceLoading(false) }
  }

  useEffect(() => { void serviceAction('status') }, [])

  const save = async (): Promise<void> => {
    setBusy('save'); setError(null)
    try {
      const projectPaths: Record<string, string> = {}
      for (const item of paths) {
        const alias = item.alias.trim()
        const path = item.path.trim()
        if (!alias || !path) throw new Error('모든 프로젝트에 별칭과 절대 경로가 필요합니다.')
        if (!path.startsWith('/')) throw new Error(`${alias}의 경로는 /로 시작하는 절대 경로여야 합니다.`)
        if (projectPaths[alias] !== undefined) throw new Error(`중복 프로젝트 별칭: ${alias}`)
        projectPaths[alias] = path
      }
      if (!draft.ompCommand.trim()) throw new Error('OMP 실행 명령을 입력하세요.')
      if (!Number.isInteger(draft.maxConcurrentRuns) || draft.maxConcurrentRuns < 1) throw new Error('동시 실행 수는 1 이상의 정수여야 합니다.')
      const next = await palace.automation.saveSettings({ ...draft, ompCommand: draft.ompCommand.trim(), projectPaths })
      onSnapshot(next); setDirty(false); showToast('머신 설정을 저장했습니다')
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(null) }
  }

  const update = <K extends keyof MachineSettings>(key: K, value: MachineSettings[K]): void => { setDraft((current) => ({ ...current, [key]: value })); setDirty(true) }
  const chooseProject = async (): Promise<void> => {
    setBusy('project'); setError(null)
    try {
      const chosen = await palace.setup.chooseProject()
      if (!chosen) return
      let alias = chosen.name
      let suffix = 2
      while (paths.some((item) => item.alias === alias && item.path !== chosen.path)) {
        alias = `${chosen.name}-${suffix}`
        suffix += 1
      }
      setPaths((current) => current.some((item) => item.path === chosen.path) ? current : [...current, { alias, path: chosen.path }])
      setDirty(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  return <section className="auto-page" aria-labelledby="machine-title">
    <header className="auto-page__header"><div><div className="auto-eyebrow">이 머신 전용</div><h1 id="machine-title">Machine</h1><p>로컬 프로젝트 경로, 실행 제한, 스케줄 소유권과 백그라운드 서비스를 관리합니다.</p></div><button className="auto-button auto-button--primary" type="button" disabled={!!busy || !dirty} onClick={() => void save()}>{busy === 'save' ? <BusyLabel label="저장 중" /> : <><Icon name="save" /> 설정 저장</>}</button></header>
    {error && <InlineError>{error}</InlineError>}
    <div className="auto-machine-id"><span className={`auto-machine-dot ${snapshot.online ? 'is-online' : ''}`} /><div><span>Machine ID</span><strong className="auto-mono">{snapshot.machineId}</strong></div><span className="auto-pill">Palace automation {snapshot.version}</span></div>

    <div className="auto-panel">
      <div className="auto-panel__head"><div><h2>프로젝트 경로</h2><p>폴더를 선택하면 자동화에서 사용할 프로젝트 별칭과 경로를 연결합니다. 이 값은 동기화되지 않습니다.</p></div><button className="auto-button" type="button" disabled={busy === 'project'} onClick={() => void chooseProject()}><Icon name="plus" /> {busy === 'project' ? '선택 중…' : '프로젝트 폴더 선택'}</button></div>
      {paths.length === 0 ? <div className="auto-compact-empty">등록된 프로젝트가 없습니다. 폴더를 선택해 추가하세요.</div> : <div className="auto-path-list">{paths.map((item, index) => <div className="auto-path-row" key={item.path}><label className="auto-field"><span>별칭</span><input value={item.alias} onChange={(event) => { setPaths((current) => current.map((path, pathIndex) => pathIndex === index ? { ...path, alias: event.target.value } : path)); setDirty(true) }} /></label><label className="auto-field auto-path-row__path"><span>선택한 폴더</span><input className="auto-mono" value={item.path} readOnly /></label><button className="auto-icon-button" type="button" aria-label={`${item.alias} 프로젝트 삭제`} onClick={() => { setPaths((current) => current.filter((_, pathIndex) => pathIndex !== index)); setDirty(true) }}><Icon name="trash" /></button></div>)}</div>}
    </div>

    <div className="auto-two-column">
      <div className="auto-panel">
        <div className="auto-panel__head"><div><h2>실행 설정</h2><p>로컬 OMP 프로세스 제한</p></div></div>
        <label className="auto-field"><span>최대 동시 실행</span><select value={draft.maxConcurrentRuns} onChange={(event) => update('maxConcurrentRuns', Number(event.target.value))}>{[1, 2, 3, 4, 6, 8].map((count) => <option value={count} key={count}>{count}개</option>)}</select></label>
        <button className="auto-text-button" type="button" aria-expanded={showAdvancedRuntime} onClick={() => setShowAdvancedRuntime((value) => !value)}><Icon name="chevron" size={14} /> 고급 실행 설정</button>
        {showAdvancedRuntime && <label className="auto-field"><span>OMP 실행 명령</span><input className="auto-mono" value={draft.ompCommand} onChange={(event) => update('ompCommand', event.target.value)} /><small>기본 설치가 아닌 OMP 실행 파일을 사용할 때만 변경하세요.</small></label>}
      </div>
      <div className={`auto-panel auto-arm-panel ${draft.armed ? 'is-armed' : ''}`}>
        <div className="auto-panel__head"><div><h2>스케줄 소유권</h2><p>예약 및 이벤트 트리거 실행</p></div><span className={`auto-status ${draft.armed ? 'auto-status--good' : ''}`}>{draft.armed ? 'ARMED' : 'DISARMED'}</span></div>
        <label className="auto-switch-row"><span><strong>이 머신에서 스케줄 실행</strong><small>수동 “지금 실행”은 이 설정과 무관합니다.</small></span><input type="checkbox" checked={draft.armed} onChange={(event) => update('armed', event.target.checked)} /><span className="auto-switch" /></label>
        <div className="auto-warning-panel auto-warning-panel--compact"><Icon name="warning" /><p><strong>한 대의 머신만 Armed로 두세요.</strong> 여러 머신을 켜면 같은 스케줄이나 GitHub 이벤트가 중복 실행될 수 있습니다.</p></div>
      </div>
    </div>

    <div className="auto-panel">
      <div className="auto-panel__head"><div><h2>백그라운드 서비스</h2><p>이 자동화는 클라우드가 아니라 이 컴퓨터에서 직접 실행됩니다.</p></div>{serviceLoading ? <span className="auto-muted"><BusyLabel label="확인 중" /></span> : service && <span className={`auto-status ${service.running ? 'auto-status--good' : service.installed ? 'auto-status--warn' : ''}`}>{service.running ? '실행 중' : service.installed ? '설치됨 · 정지' : '미설치'}</span>}</div>
      <div className="auto-disclosure auto-disclosure--service"><Icon name="machine" /><div><strong>이 컴퓨터가 깨어 있고 Palace OMP 서비스가 실행 중일 때만 동작합니다.</strong><p>스케줄, GitHub 이벤트, 웹훅은 호스팅 서비스가 대신 처리하지 않습니다. 안정적인 예약 실행을 위해 패키징된 Palace OMP에서 백그라운드 서비스를 설치하고 이 Mac의 잠자기 설정을 확인하세요.</p></div></div>
      {service && <div className="auto-service-row"><div><strong>{service.message}</strong><span>{service.installed ? '이 머신에 서비스가 등록되어 있습니다. 컴퓨터가 잠들거나 서비스가 멈추면 스케줄도 멈춥니다.' : '백그라운드 서비스는 패키징된 Palace OMP에서 설치할 수 있습니다.'}</span></div><div className="auto-header-actions"><button className="auto-button" type="button" disabled={!!busy} onClick={() => void serviceAction('status')}><Icon name="refresh" /> 새로고침</button>{service.installed ? <button className="auto-button auto-button--danger-ghost" type="button" disabled={!!busy} onClick={() => void serviceAction('uninstall')}>{busy === 'service:uninstall' ? <BusyLabel label="제거 중" /> : '서비스 제거'}</button> : <button className="auto-button auto-button--primary" type="button" disabled={!!busy} onClick={() => void serviceAction('install')}>{busy === 'service:install' ? <BusyLabel label="설치 중" /> : '서비스 설치'}</button>}</div></div>}
      {!serviceLoading && !service && <div className="auto-service-row"><span>서비스 상태를 불러오지 못했습니다.</span><button className="auto-button" type="button" disabled={!!busy} onClick={() => void serviceAction('status')}><Icon name="refresh" /> 다시 확인</button></div>}
    </div>
  </section>
}
