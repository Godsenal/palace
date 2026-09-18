import { useEffect, useMemo, useState } from 'react'
import { palace } from '../../api'
import type { AutomationSnapshot, LoopDefinition, Trigger, WebhookAccess } from '../../../../shared/automation'
import { BusyLabel, Icon, InlineError, Modal } from './ui'

interface Props {
  snapshot: AutomationSnapshot
  onSnapshot: (snapshot: AutomationSnapshot) => void
  showToast: (message: string) => void
}

const newLoop = (): LoopDefinition => ({
  id: `loop-${Date.now().toString(36)}`,
  name: '',
  project: '',
  mission: '',
  trigger: { kind: 'manual' },
  model: 'auto',
  checks: [],
  maxAttempts: 3,
  timeoutMinutes: 30,
  enabled: false
})

export function AutomationsView({ snapshot, onSnapshot, showToast }: Props): JSX.Element {
  const [editing, setEditing] = useState<LoopDefinition | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [approveTarget, setApproveTarget] = useState<LoopDefinition | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LoopDefinition | null>(null)
  const [webhookTarget, setWebhookTarget] = useState<LoopDefinition | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<Array<{ id: string; name: string; provider: string }>>([])
  useEffect(() => { palace.ide.models().then(setModels).catch(() => setModels([])) }, [])
  const loops = snapshot.profile.loops
  const runningLoopIds = useMemo(() => new Set(snapshot.runs.filter((run) => ['queued', 'running', 'checking'].includes(run.status)).map((run) => run.loopId)), [snapshot.runs])

  const act = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await fn()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(null)
    }
  }

  const toggleLoop = (loop: LoopDefinition): Promise<void> => act(`toggle:${loop.id}`, async () => {
    const next = await palace.automation.saveLoop({ ...loop, enabled: !loop.enabled })
    onSnapshot(next)
    showToast(loop.enabled ? '자동 실행을 껐습니다' : '자동 실행을 켰습니다')
  })

  const runLoop = (loop: LoopDefinition): Promise<void> => act(`run:${loop.id}`, async () => {
    const run = await palace.automation.runLoop(loop.id)
    showToast(`${loop.name} 실행을 시작했습니다 · ${run.id}`)
  })

  const approve = async (): Promise<void> => {
    if (!approveTarget) return
    const target = approveTarget
    await act(`approve:${target.id}`, async () => {
      const next = await palace.automation.approveLoop(target.id)
      onSnapshot(next)
      setApproveTarget(null)
      showToast('이 머신에서 실행을 승인했습니다')
    })
  }

  const remove = async (): Promise<void> => {
    if (!deleteTarget) return
    const target = deleteTarget
    await act(`delete:${target.id}`, async () => {
      const next = await palace.automation.deleteLoop(target.id)
      onSnapshot(next)
      setDeleteTarget(null)
      showToast('자동화를 삭제했습니다')
    })
  }

  return (
    <section className="auto-page" aria-labelledby="automations-title">
      <header className="auto-page__header">
        <div>
          <div className="auto-eyebrow">워크플로</div>
          <h1 id="automations-title">Automations</h1>
          <p>반복 작업을 정의하고 이 머신의 OMP에서 실행합니다.</p>
        </div>
        <button className="auto-button auto-button--primary" type="button" onClick={() => { setEditing(newLoop()); setIsNew(true) }}>
          <Icon name="plus" /> 새 자동화
        </button>
      </header>

      {snapshot.schedulerError && <InlineError>스케줄러: {snapshot.schedulerError}</InlineError>}
      {error && <InlineError>{error}</InlineError>}

      <div className="auto-summary-strip" aria-label="자동화 요약">
        <div><span>전체</span><strong>{loops.length}</strong></div>
        <div><span>활성</span><strong>{loops.filter((loop) => loop.enabled).length}</strong></div>
        <div><span>승인됨</span><strong>{loops.filter((loop) => snapshot.approved[loop.id]).length}</strong></div>
        <div><span>실행 중</span><strong>{runningLoopIds.size}</strong></div>
      </div>

      {loops.length === 0 ? (
        <div className="auto-empty auto-empty--page">
          <div className="auto-empty__mark"><Icon name="automation" size={22} /></div>
          <strong>아직 자동화가 없습니다</strong>
          <p>미션, 실행 조건, 검사를 한곳에 정의하세요. 저장 후 이 머신의 실행 승인이 필요합니다.</p>
          <button className="auto-button auto-button--primary" type="button" onClick={() => { setEditing(newLoop()); setIsNew(true) }}><Icon name="plus" /> 첫 자동화 만들기</button>
        </div>
      ) : (
        <div className="auto-card-grid">
          {loops.map((loop) => {
            const approved = !!snapshot.approved[loop.id]
            const active = runningLoopIds.has(loop.id)
            return (
              <article className="auto-loop-card" key={loop.id}>
                <div className="auto-loop-card__head">
                  <div className={`auto-loop-icon ${loop.enabled ? 'is-enabled' : ''}`}><Icon name="automation" /></div>
                  <div className="auto-loop-card__title">
                    <div className="auto-loop-card__name-row"><h2>{loop.name}</h2>{active && <span className="auto-live-dot">실행 중</span>}</div>
                    <span className="auto-mono">{loop.id}</span>
                  </div>
                  <button className="auto-icon-button" type="button" aria-label={`${loop.name} 편집`} onClick={() => { setEditing(loop); setIsNew(false) }}><Icon name="edit" /></button>
                </div>
                <p className="auto-loop-card__mission">{loop.mission}</p>
                <dl className="auto-loop-meta">
                  <div><dt>프로젝트</dt><dd>{loop.project}</dd></div>
                  <div><dt>모델</dt><dd>{loop.model}</dd></div>
                  <div><dt>트리거</dt><dd>{triggerLabel(loop.trigger)}</dd></div>
                  <div><dt>검사</dt><dd>{loop.checks.length ? `${loop.checks.length}개` : '없음'}</dd></div>
                </dl>
                <div className="auto-loop-card__state">
                  <span className={`auto-pill ${approved ? 'auto-pill--good' : 'auto-pill--warn'}`}>{approved ? <><Icon name="check" size={13} /> 이 머신 승인됨</> : '승인 필요'}</span>
                  <span className={`auto-pill ${loop.enabled ? 'auto-pill--good' : ''}`}>{loop.enabled ? '스케줄 활성' : '스케줄 꺼짐'}</span>
                </div>
                <div className="auto-loop-card__actions">
                  <button className="auto-button auto-button--primary" type="button" disabled={!!busy || !approved} onClick={() => void runLoop(loop)}>
                    {busy === `run:${loop.id}` ? <BusyLabel label="시작 중" /> : <><Icon name="play" /> 지금 실행</>}
                  </button>
                  {!approved ? (
                    <button className="auto-button" type="button" onClick={() => setApproveTarget(loop)}><Icon name="check" /> 승인</button>
                  ) : (
                    <button className="auto-button" type="button" disabled={!!busy} onClick={() => void toggleLoop(loop)}>{busy === `toggle:${loop.id}` ? <BusyLabel label="저장 중" /> : loop.enabled ? <><Icon name="pause" /> 끄기</> : <><Icon name="play" /> 켜기</>}</button>
                  )}
                  {loop.trigger.kind === 'webhook' && <button className="auto-icon-button" type="button" aria-label={`${loop.name} 웹훅 정보`} onClick={() => setWebhookTarget(loop)}><Icon name="webhook" /></button>}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {editing && <LoopEditor
        initial={editing}
        isNew={isNew}
        projects={Object.keys(snapshot.settings.projectPaths)}
        models={models}
        busy={busy === `save:${editing.id}`}
        onClose={() => setEditing(null)}
        onDelete={!isNew ? () => { setDeleteTarget(editing); setEditing(null) } : undefined}
        onSave={(loop) => void act(`save:${editing.id}`, async () => {
          const next = await palace.automation.saveLoop(loop)
          onSnapshot(next)
          setEditing(null)
          showToast(isNew ? '자동화를 만들었습니다' : '자동화를 저장했습니다')
        })}
      />}

      {approveTarget && <Modal
        title="이 머신에서 실행 승인"
        description={approveTarget.name}
        onClose={() => setApproveTarget(null)}
        width="small"
        footer={<><button className="auto-button" type="button" onClick={() => setApproveTarget(null)}>취소</button><button className="auto-button auto-button--danger" type="button" disabled={!!busy} onClick={() => void approve()}>{busy?.startsWith('approve:') ? <BusyLabel label="승인 중" /> : '로컬 실행 승인'}</button></>}
      >
        <div className="auto-warning-panel"><Icon name="warning" /><div><strong>이 작업은 샌드박스에서 실행되지 않습니다.</strong><p>OMP가 <span className="auto-mono">{snapshot.settings.projectPaths[approveTarget.project] || approveTarget.project}</span>의 로컬 코드를 읽고 수정하며 명령과 검사를 실행할 수 있습니다. 미션과 검사 명령을 신뢰할 때만 승인하세요.</p></div></div>
      </Modal>}

      {deleteTarget && <Modal
        title="자동화 삭제"
        description="이 작업은 되돌릴 수 없습니다. 이전 실행 기록은 남을 수 있습니다."
        onClose={() => setDeleteTarget(null)}
        width="small"
        footer={<><button className="auto-button" type="button" onClick={() => setDeleteTarget(null)}>취소</button><button className="auto-button auto-button--danger" type="button" disabled={!!busy} onClick={() => void remove()}>{busy?.startsWith('delete:') ? <BusyLabel label="삭제 중" /> : '삭제'}</button></>}
      ><p><strong>{deleteTarget.name}</strong> 자동화를 삭제합니다.</p></Modal>}

      {webhookTarget && <WebhookModal loop={webhookTarget} onClose={() => setWebhookTarget(null)} showToast={showToast} />}
    </section>
  )
}

function LoopEditor({ initial, isNew, projects, models, busy, onClose, onSave, onDelete }: {
  initial: LoopDefinition
  isNew: boolean
  projects: string[]
  models: Array<{ id: string; name: string; provider: string }>
  busy: boolean
  onClose: () => void
  onSave: (loop: LoopDefinition) => void
  onDelete?: () => void
}): JSX.Element {
  const [draft, setDraft] = useState<LoopDefinition>(() => structuredClone(initial))
  const [formError, setFormError] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const set = <K extends keyof LoopDefinition>(key: K, value: LoopDefinition[K]): void => setDraft((current) => ({ ...current, [key]: value }))
  const submit = (): void => {
    const required: Array<[string, string]> = [[draft.id, 'ID'], [draft.name, '이름'], [draft.project, '프로젝트 별칭'], [draft.mission, '미션']]
    const missing = required.find(([value]) => !value.trim())
    if (missing) return setFormError(`${missing[1]}을 입력하세요.`)
    if (!Number.isFinite(draft.maxAttempts) || draft.maxAttempts < 1) return setFormError('최대 시도 횟수는 1 이상이어야 합니다.')
    if (!Number.isFinite(draft.timeoutMinutes) || draft.timeoutMinutes < 1) return setFormError('타임아웃은 1분 이상이어야 합니다.')
    if (draft.trigger.kind === 'interval' && draft.trigger.seconds < 10) return setFormError('반복 간격은 10초 이상이어야 합니다.')
    if (draft.trigger.kind === 'daily' && (!draft.trigger.time || !draft.trigger.timezone.trim())) return setFormError('매일 실행 시간과 시간대를 입력하세요.')
    if (draft.trigger.kind === 'cron' && (!draft.trigger.expression.trim() || !draft.trigger.timezone.trim())) return setFormError('Cron 표현식과 시간대가 필요합니다.')
    if (draft.trigger.kind === 'github' && (!draft.trigger.repository.trim() || !Number.isInteger(draft.trigger.pollSeconds) || draft.trigger.pollSeconds < 30 || draft.trigger.pollSeconds > 3600)) return setFormError('GitHub 저장소와 30~3600초의 확인 주기가 필요합니다.')
    setFormError(null)
    onSave({ ...draft, id: draft.id.trim(), name: draft.name.trim(), project: draft.project.trim(), model: draft.model.trim(), mission: draft.mission.trim(), checks: draft.checks.map((check) => check.trim()).filter(Boolean) })
  }

  return <Modal
    title={isNew ? '새 자동화' : '자동화 편집'}
    description="실행 정의는 OMP Sync로 공유되며, 머신 승인은 공유되지 않습니다."
    onClose={onClose}
    width="large"
    footer={<><div className="auto-modal__footer-left">{onDelete && <button className="auto-button auto-button--danger-ghost" type="button" onClick={onDelete}><Icon name="trash" /> 삭제</button>}</div><button className="auto-button" type="button" onClick={onClose}>취소</button><button className="auto-button auto-button--primary" type="button" disabled={busy} onClick={submit}>{busy ? <BusyLabel label="저장 중" /> : <><Icon name="save" /> 저장</>}</button></>}
  >
    <div className="auto-form-grid">
      <label className="auto-field"><span>이름</span><input value={draft.name} onChange={(event) => set('name', event.target.value)} autoFocus /></label>
      <label className="auto-field"><span>프로젝트</span><select value={draft.project} onChange={(event) => set('project', event.target.value)}><option value="">프로젝트 선택</option>{projects.map((project) => <option key={project} value={project}>{project}</option>)}</select><small>Machine에서 등록한 프로젝트 중 선택합니다.</small></label>
      <label className="auto-field"><span>모델</span><select value={draft.model || 'auto'} onChange={(event) => set('model', event.target.value)}><option value="auto">Auto · OMP 기본값</option>{draft.model && draft.model !== 'auto' && !models.some((model) => `${model.provider}/${model.id}` === draft.model) && <option value={draft.model}>{draft.model} · 기존 설정</option>}{models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}</select><small>Auto는 실행 머신의 OMP 기본 모델을 사용합니다.</small></label>
      <div className="auto-field auto-field--wide"><button className="auto-text-button" type="button" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((value) => !value)}><Icon name="chevron" size={14} /> 고급 설정</button>{showAdvanced && <label className="auto-field"><span>ID</span><input className="auto-mono" value={draft.id} disabled={!isNew} onChange={(event) => set('id', event.target.value)} /><small>자동화 식별자가 필요한 경우에만 수정하세요. 생성 후에는 바꿀 수 없습니다.</small></label>}</div>
      <label className="auto-field auto-field--wide"><span>미션</span><textarea rows={5} value={draft.mission} onChange={(event) => set('mission', event.target.value)} /><small>완료 조건과 변경 범위를 구체적으로 작성하세요.</small></label>
      <div className="auto-field auto-field--wide"><span>트리거</span><TriggerEditor value={draft.trigger} onChange={(trigger) => set('trigger', trigger)} /></div>
      <div className="auto-field auto-field--wide"><div className="auto-field__title"><span>검사 명령</span><button className="auto-text-button" type="button" onClick={() => set('checks', [...draft.checks, ''])}><Icon name="plus" size={14} /> 검사 추가</button></div>{draft.checks.length === 0 ? <small>검사가 없으면 자동 성공이 아닌 ‘검토 필요’ 상태로 종료합니다.</small> : <div className="auto-list-editor">{draft.checks.map((check, index) => <div key={index} className="auto-list-editor__row"><span className="auto-list-index">{index + 1}</span><input className="auto-mono" aria-label={`검사 명령 ${index + 1}`} value={check} onChange={(event) => set('checks', draft.checks.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} /><button className="auto-icon-button" type="button" aria-label={`검사 명령 ${index + 1} 삭제`} onClick={() => set('checks', draft.checks.filter((_, itemIndex) => itemIndex !== index))}><Icon name="close" /></button></div>)}</div>}</div>
      <label className="auto-field"><span>최대 시도</span><input type="number" min={1} max={20} value={draft.maxAttempts} onChange={(event) => set('maxAttempts', Number(event.target.value))} /></label>
      <label className="auto-field"><span>타임아웃 (분)</span><input type="number" min={1} max={1440} value={draft.timeoutMinutes} onChange={(event) => set('timeoutMinutes', Number(event.target.value))} /></label>
      <label className="auto-toggle-row auto-field--wide"><input type="checkbox" checked={draft.enabled} onChange={(event) => set('enabled', event.target.checked)} /><span><strong>스케줄 활성화</strong><small>저장해도 이 머신의 실행 승인과 Machine의 Armed 설정이 모두 필요합니다.</small></span></label>
    </div>
    {formError && <InlineError>{formError}</InlineError>}
  </Modal>
}

const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const TIMEZONES = [LOCAL_TIMEZONE, 'Asia/Seoul', 'America/Los_Angeles', 'America/New_York', 'Europe/London', 'UTC'].filter((timezone, index, values) => values.indexOf(timezone) === index)
const CRON_PRESETS = [
  { label: '매시간 정각', expression: '0 * * * *' },
  { label: '평일 오전 9시', expression: '0 9 * * 1-5' },
  { label: '매주 월요일 오전 9시', expression: '0 9 * * 1' },
  { label: '매월 1일 오전 9시', expression: '0 9 1 * *' }
]

function TriggerEditor({ value, onChange }: { value: Trigger; onChange: (trigger: Trigger) => void }): JSX.Element {
  const [customCron, setCustomCron] = useState(value.kind === 'cron' && !CRON_PRESETS.some((preset) => preset.expression === value.expression))
  const switchKind = (next: Trigger['kind']): void => {
    if (next === 'manual') onChange({ kind: 'manual' })
    if (next === 'interval') onChange({ kind: 'interval', seconds: 300 })
    if (next === 'daily') onChange({ kind: 'daily', time: '09:00', timezone: LOCAL_TIMEZONE })
    if (next === 'cron') onChange({ kind: 'cron', expression: CRON_PRESETS[0].expression, timezone: LOCAL_TIMEZONE })
    if (next === 'github') onChange({ kind: 'github', repository: '', event: 'issue_opened', pollSeconds: 120 })
    if (next === 'webhook') onChange({ kind: 'webhook' })
  }
  const cronPreset = value.kind === 'cron' && !customCron && CRON_PRESETS.some((preset) => preset.expression === value.expression) ? value.expression : 'custom'
  return <div className="auto-trigger-editor">
    <label className="auto-field auto-field--compact"><span>트리거 종류</span><select value={value.kind} onChange={(event) => switchKind(event.target.value as Trigger['kind'])}><option value="manual">수동 실행</option><option value="interval">일정 간격</option><option value="daily">매일 지정 시간</option><option value="cron">스케줄 프리셋</option><option value="github">GitHub 이벤트</option><option value="webhook">웹훅</option></select></label>
    {value.kind === 'manual' && <p className="auto-field-note">대시보드에서 “지금 실행”을 눌렀을 때만 시작합니다.</p>}
    {value.kind === 'interval' && <label className="auto-field auto-field--compact"><span>실행 간격</span><select value={value.seconds} onChange={(event) => onChange({ ...value, seconds: Number(event.target.value) })}>{![300, 900, 1800, 3600, 21600, 86400].includes(value.seconds) && <option value={value.seconds}>{value.seconds}초 · 기존 설정</option>}<option value={300}>5분마다</option><option value={900}>15분마다</option><option value={1800}>30분마다</option><option value={3600}>1시간마다</option><option value={21600}>6시간마다</option><option value={86400}>24시간마다</option></select></label>}
    {value.kind === 'daily' && <div className="auto-inline-fields"><label className="auto-field"><span>시간</span><input type="time" value={value.time} onChange={(event) => onChange({ ...value, time: event.target.value })} /></label><label className="auto-field"><span>시간대</span><select value={value.timezone} onChange={(event) => onChange({ ...value, timezone: event.target.value })}>{!TIMEZONES.includes(value.timezone) && <option value={value.timezone}>{value.timezone} · 기존 설정</option>}{TIMEZONES.map((timezone) => <option value={timezone} key={timezone}>{timezone === LOCAL_TIMEZONE ? `${timezone} · 이 컴퓨터` : timezone}</option>)}</select></label></div>}
    {value.kind === 'cron' && <div className="auto-form-grid auto-form-grid--nested"><label className="auto-field"><span>실행 일정</span><select value={cronPreset} onChange={(event) => { setCustomCron(event.target.value === 'custom'); if (event.target.value !== 'custom') onChange({ ...value, expression: event.target.value }) }}>{CRON_PRESETS.map((preset) => <option value={preset.expression} key={preset.expression}>{preset.label}</option>)}<option value="custom">고급 · 직접 지정</option></select></label><label className="auto-field"><span>시간대</span><select value={value.timezone} onChange={(event) => onChange({ ...value, timezone: event.target.value })}>{!TIMEZONES.includes(value.timezone) && <option value={value.timezone}>{value.timezone} · 기존 설정</option>}{TIMEZONES.map((timezone) => <option value={timezone} key={timezone}>{timezone === LOCAL_TIMEZONE ? `${timezone} · 이 컴퓨터` : timezone}</option>)}</select></label>{cronPreset === 'custom' && <label className="auto-field auto-field--wide"><span>Cron 표현식 · 고급</span><input className="auto-mono" value={value.expression} onChange={(event) => onChange({ ...value, expression: event.target.value })} /><small>분 시 일 월 요일의 5개 필드를 사용합니다.</small></label>}</div>}
    {value.kind === 'github' && <div className="auto-form-grid auto-form-grid--nested"><label className="auto-field"><span>저장소 (owner/repo)</span><input value={value.repository} onChange={(event) => onChange({ ...value, repository: event.target.value })} /></label><label className="auto-field"><span>이벤트</span><select value={value.event} onChange={(event) => onChange({ ...value, event: event.target.value as Extract<Trigger, { kind: 'github' }>['event'] })}><option value="issue_opened">Issue opened</option><option value="pull_request_review">Pull request review</option><option value="workflow_failed">Workflow failed</option></select></label><label className="auto-field"><span>확인 주기</span><select value={value.pollSeconds} onChange={(event) => onChange({ ...value, pollSeconds: Number(event.target.value) })}>{![60, 120, 300, 900].includes(value.pollSeconds) && <option value={value.pollSeconds}>{value.pollSeconds}초 · 기존 설정</option>}<option value={60}>1분</option><option value={120}>2분</option><option value={300}>5분</option><option value={900}>15분</option></select></label></div>}
    {value.kind === 'webhook' && <p className="auto-field-note">저장 후 자동화 카드에서 이 머신 전용 URL과 토큰을 확인할 수 있습니다.</p>}
  </div>
}

function WebhookModal({ loop, onClose, showToast }: { loop: LoopDefinition; onClose: () => void; showToast: (message: string) => void }): JSX.Element {
  const [access, setAccess] = useState<WebhookAccess | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [deliveryId] = useState(() => crypto.randomUUID())

  const load = async (): Promise<void> => {
    setLoading(true); setError(null)
    try { setAccess(await palace.automation.webhook(loop.id)) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }
  const copy = async (value: string, label: string): Promise<void> => { await navigator.clipboard.writeText(value); showToast(`${label}을 복사했습니다`) }
  const sample = access ? `curl -X POST '${access.url}' \\\n  -H 'Authorization: Bearer ${access.token}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'X-Delivery-ID: ${deliveryId}' \\\n  -d '{}'` : ''

  return <Modal title="웹훅 연결" description={`${loop.name} · 이 머신 전용`} onClose={onClose} width="large" footer={<button className="auto-button" type="button" onClick={onClose}>닫기</button>}>
    {!access && !loading && <div className="auto-secret-gate"><Icon name="webhook" size={24} /><strong>접속 정보를 불러오시겠습니까?</strong><p>토큰은 로컬 자격 정보입니다. 화면 공유 중이 아닌지 확인하세요.</p><button className="auto-button auto-button--primary" type="button" onClick={() => void load()}>URL과 토큰 표시</button></div>}
    {loading && <div className="auto-loading-block"><BusyLabel label="웹훅 정보를 불러오는 중" /></div>}
    {error && <><InlineError>{error}</InlineError><button className="auto-button" type="button" onClick={() => void load()}><Icon name="refresh" /> 다시 시도</button></>}
    {access && <div className="auto-stack">
      <div className="auto-info-panel"><strong>이 컴퓨터 전용 엔드포인트</strong><p>서비스는 127.0.0.1에만 연결됩니다. 같은 컴퓨터에서만 호출할 수 있으며, 외부 연결에는 별도의 인증된 HTTPS 프록시가 필요합니다.</p></div>
      <label className="auto-field"><span>Webhook URL</span><div className="auto-copy-field"><input className="auto-mono" readOnly value={access.url} /><button className="auto-icon-button" type="button" aria-label="웹훅 URL 복사" onClick={() => void copy(access.url, 'URL')}><Icon name="copy" /></button></div></label>
      <label className="auto-field"><span>Bearer token</span><div className="auto-copy-field"><input className="auto-mono" type={revealed ? 'text' : 'password'} readOnly value={access.token} /><button className="auto-icon-button" type="button" aria-label={revealed ? '토큰 숨기기' : '토큰 표시'} onClick={() => setRevealed((value) => !value)}><Icon name={revealed ? 'eyeOff' : 'eye'} /></button><button className="auto-icon-button" type="button" aria-label="토큰 복사" onClick={() => void copy(access.token, '토큰')}><Icon name="copy" /></button></div></label>
      <div className="auto-code-sample"><div><span>요청 예시</span><button className="auto-text-button" type="button" onClick={() => void copy(sample, '요청 예시')}><Icon name="copy" size={14} /> 복사</button></div><pre>{sample}</pre></div>
      <p className="auto-footnote"><span className="auto-mono">X-Delivery-ID</span>는 요청마다 고유해야 합니다. 중복 전송 방지에 사용됩니다.</p>
    </div>}
  </Modal>
}

function triggerLabel(trigger: Trigger): string {
  if (trigger.kind === 'manual') return '수동'
  if (trigger.kind === 'interval') return `${Math.round(trigger.seconds / 60)}분마다`
  if (trigger.kind === 'daily') return `매일 ${trigger.time} · ${trigger.timezone}`
  if (trigger.kind === 'cron') return `${CRON_PRESETS.find((preset) => preset.expression === trigger.expression)?.label || trigger.expression} · ${trigger.timezone}`
  if (trigger.kind === 'github') return `${trigger.repository} · ${trigger.event}`
  return '웹훅'
}
