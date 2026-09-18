import { useCallback, useEffect, useState } from 'react'
import { palace } from '../../api'
import type { InstalledSkill, SkillCandidate, SkillPreview } from '../../../../shared/workbench'
import { Modal } from '../automation/ui'
import { formatDate, messageOf } from './RichText'
import { WorkbenchIcon } from './WorkbenchIcon'

type Project = { name: string; path: string }
type Review = { action: 'install' | 'update' | 'remove'; candidate?: SkillCandidate; installed?: InstalledSkill; preview?: SkillPreview }

export function SkillsView({ visible, showToast }: { visible: boolean; showToast: (message: string) => void }): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState('')
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [results, setResults] = useState<SkillCandidate[]>([])
  const [selected, setSelected] = useState<SkillCandidate | null>(null)
  const [preview, setPreview] = useState<SkillPreview | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadInstalled = useCallback(async (path: string): Promise<void> => {
    if (!path) { setInstalled([]); return }
    try { setInstalled(await palace.skills.list(path)); setError(null) }
    catch (reason) { setError(messageOf(reason)) }
  }, [])

  useEffect(() => {
    if (!visible) return
    palace.setup.status().then((status) => {
      setProjects(status.projects)
      setProject((current) => current || status.projects[0]?.path || '')
    }).catch((reason) => setError(messageOf(reason)))
  }, [visible])
  useEffect(() => { void loadInstalled(project) }, [project, loadInstalled])

  const chooseProject = async (): Promise<void> => {
    try {
      const chosen = await palace.setup.chooseProject()
      if (!chosen) return
      setProjects((current) => current.some((item) => item.path === chosen.path) ? current : [...current, chosen])
      setProject(chosen.path)
    } catch (reason) { setError(messageOf(reason)) }
  }

  const search = async (): Promise<void> => {
    const value = advanced && source.trim() ? source.trim() : query.trim()
    if (!value) return
    setBusy('search'); setError(null); setSelected(null); setPreview(null)
    try {
      if (advanced && source.trim()) {
        const next = await palace.skills.preview(source.trim())
        setResults(next.candidates); setPreview(next)
      } else setResults(await palace.skills.search(query.trim()))
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  const inspect = async (candidate: SkillCandidate): Promise<void> => {
    setSelected(candidate); setBusy(`preview:${candidate.id}`); setError(null)
    try { setPreview(await palace.skills.preview(candidate.source, candidate.id)) }
    catch (reason) { setError(messageOf(reason)); setPreview(null) }
    finally { setBusy(null) }
  }

  const prepareUpdate = async (skill: InstalledSkill): Promise<void> => {
    setBusy(`update:${skill.id}`); setError(null)
    try { setReview({ action: 'update', installed: skill, preview: await palace.skills.preview(skill.source, skill.id) }) }
    catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  const confirm = async (): Promise<void> => {
    if (!review || !project) return
    setBusy('confirm'); setError(null)
    try {
      if (review.action === 'install' && review.candidate && review.preview) {
        await palace.skills.install(project, review.candidate.source, review.candidate.id, review.preview.revision)
        showToast(`${review.candidate.name} Skill을 설치했습니다`)
      } else if (review.action === 'update' && review.installed && review.preview) {
        await palace.skills.update(project, review.installed.id, review.preview.revision)
        showToast(`${review.installed.name} Skill을 업데이트했습니다`)
      } else if (review.action === 'remove' && review.installed) {
        await palace.skills.remove(project, review.installed.id)
        showToast(`${review.installed.name} Skill을 제거했습니다`)
      }
      setReview(null); await loadInstalled(project)
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  return <section className="wb-page" hidden={!visible} aria-labelledby="skills-title">
    <header className="wb-page-header"><div><span className="wb-eyebrow">PROJECT CAPABILITIES</span><h1 id="skills-title">Skills</h1><p>검토한 Skill을 프로젝트의 <code>.agent/skills</code>에 설치하고 업데이트합니다.</p></div><div className="wb-project-picker"><select value={project} onChange={(event) => setProject(event.target.value)} aria-label="Skill 프로젝트"><option value="">프로젝트 선택</option>{projects.map((item) => <option value={item.path} key={item.path}>{item.name}</option>)}</select><button className="wb-button" type="button" onClick={() => void chooseProject()}>폴더 선택</button></div></header>
    {error && <div className="wb-error" role="alert"><WorkbenchIcon name="warning" /><span>{error}</span><button type="button" onClick={() => setError(null)}><WorkbenchIcon name="close" size={14} /></button></div>}
    <div className="wb-skill-layout">
      <div className="wb-skill-discovery">
        <div className="wb-search-panel"><div className="wb-search-box"><WorkbenchIcon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search() }} placeholder="예: Supabase, UI polish, deployment" aria-label="Skill 검색" /><button className="wb-button wb-button--primary" type="button" disabled={busy === 'search' || (!query.trim() && !source.trim())} onClick={() => void search()}>{busy === 'search' ? '검색 중…' : '검색'}</button></div><button className="wb-disclosure-button" type="button" aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}><WorkbenchIcon name="chevron" size={14} /> 고급: Git 저장소 직접 지정</button>{advanced && <label className="wb-advanced-field"><span>저장소 주소 또는 owner/repo</span><input value={source} onChange={(event) => setSource(event.target.value)} placeholder="https://github.com/owner/repo" /></label>}</div>
        <div className="wb-results-list">{results.map((candidate) => <button className={`wb-result-card ${selected?.id === candidate.id ? 'is-active' : ''}`} type="button" onClick={() => void inspect(candidate)} key={`${candidate.source}:${candidate.id}`}><span className="wb-result-icon"><WorkbenchIcon name="skills" /></span><span><strong>{candidate.name}</strong><small>{candidate.description || '설명 없음'}</small><em>{candidate.source}{candidate.installs !== undefined ? ` · ${candidate.installs.toLocaleString()}회 설치` : ''}</em></span><WorkbenchIcon name="chevron" size={15} /></button>)}{!busy && results.length === 0 && <div className="wb-list-empty"><WorkbenchIcon name="search" size={24} /><strong>필요한 기능을 검색하세요</strong><p>검색 결과에서 파일과 출처를 먼저 검토한 뒤 설치합니다.</p></div>}</div>
      </div>
      <aside className="wb-skill-preview">
        {!selected && !preview ? <div className="wb-panel-empty">검색 결과를 선택하면 파일과 출처를 미리 볼 수 있습니다.</div> : busy?.startsWith('preview:') ? <div className="wb-loading"><span className="spin" /> Skill을 읽는 중</div> : preview ? <><div className="wb-preview-head"><div><span className="wb-eyebrow">설치 전 검토</span><h2>{selected?.name || '저장소의 Skills'}</h2><p>{preview.source}</p></div>{selected && <button className="wb-button wb-button--primary" type="button" disabled={!project || !preview.selected} onClick={() => setReview({ action: 'install', candidate: selected, preview })}><WorkbenchIcon name="download" /> 설치 검토</button>}</div><dl className="wb-preview-facts"><div><dt>Revision</dt><dd>{preview.revision}</dd></div><div><dt>발견된 Skill</dt><dd>{preview.candidates.length}개</dd></div><div><dt>설치 위치</dt><dd>.agent/skills/{selected?.id || '…'}</dd></div></dl>{preview.selected ? <div className="wb-preview-files">{preview.selected.files.map((file) => <details key={file.path}><summary><span>{file.path}</span><em>{new Blob([file.content]).size.toLocaleString()} B</em></summary><pre>{file.content}</pre></details>)}</div> : <div className="wb-panel-empty">왼쪽에서 설치할 Skill을 선택하세요.</div>}</> : null}
      </aside>
    </div>
    <section className="wb-installed-section"><div className="wb-section-head"><div><h2>이 프로젝트에 설치됨</h2><p><code>{project || '프로젝트'}/.agent/skills</code></p></div><span>{installed.length}개</span></div><div className="wb-installed-grid">{installed.map((skill) => <article className="wb-installed-card" key={skill.id}><div><span className="wb-result-icon"><WorkbenchIcon name="skills" /></span><span className={`wb-state-label ${skill.modified ? 'is-warn' : 'is-good'}`}>{skill.modified ? '로컬 수정됨' : '동기화됨'}</span></div><h3>{skill.name}</h3><p>{skill.description || '설명 없음'}</p><small>{skill.source} · {formatDate(skill.installedAt)}</small><div><button className="wb-button" type="button" disabled={!!busy} onClick={() => void prepareUpdate(skill)}><WorkbenchIcon name="refresh" size={14} /> 업데이트 검토</button><button className="wb-icon-button is-danger" type="button" aria-label={`${skill.name} 제거`} onClick={() => setReview({ action: 'remove', installed: skill })}><WorkbenchIcon name="trash" /></button></div></article>)}{project && installed.length === 0 && <div className="wb-list-empty"><strong>설치된 Skill이 없습니다</strong><p>검색 결과를 검토해 프로젝트에 추가하세요.</p></div>}{!project && <div className="wb-list-empty"><strong>프로젝트를 선택하세요</strong><p>Skill은 전역이 아니라 각 프로젝트의 .agent/skills에 설치됩니다.</p></div>}</div></section>
    {review && <ReviewModal review={review} busy={busy === 'confirm'} onClose={() => setReview(null)} onConfirm={() => void confirm()} />}
  </section>
}

function ReviewModal({ review, busy, onClose, onConfirm }: { review: Review; busy: boolean; onClose: () => void; onConfirm: () => void }): JSX.Element {
  const title = review.action === 'install' ? 'Skill 설치 검토' : review.action === 'update' ? 'Skill 업데이트 검토' : 'Skill 제거 확인'
  const name = review.candidate?.name || review.installed?.name || 'Skill'
  return <Modal title={title} description={`${name} · 프로젝트의 .agent/skills`} onClose={onClose} width="large" footer={<><button className="auto-button" type="button" onClick={onClose}>취소</button><button className={`auto-button ${review.action === 'remove' ? 'auto-button--danger' : 'auto-button--primary'}`} type="button" disabled={busy} onClick={onConfirm}>{busy ? '처리 중…' : review.action === 'install' ? '검토하고 설치' : review.action === 'update' ? '검토하고 업데이트' : '제거'}</button></>}>
    {review.action === 'remove' ? <div className="wb-warning-box"><WorkbenchIcon name="warning" /><p><strong>{name}</strong>의 설치 파일을 프로젝트에서 제거합니다. 로컬 수정이 있다면 함께 사라질 수 있습니다.</p></div> : <><div className="wb-review-source"><span>출처</span><strong>{review.preview?.source}</strong><small>고정 revision: {review.preview?.revision}</small></div><div className="wb-review-files">{review.preview?.selected?.files.map((file) => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>)}</div></>}
  </Modal>
}
