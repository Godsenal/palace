import { useCallback, useEffect, useRef, useState } from 'react'
import { palace } from '../../api'
import { SKILL_CATEGORIES, SKILL_RECOMMENDATIONS } from '../../../../shared/skill-catalog'
import type { RecommendedSkill, SkillCategoryId } from '../../../../shared/skill-catalog'
import type { InstalledSkill, SkillCandidate, SkillLocations, SkillPreview, SkillTarget } from '../../../../shared/workbench'
import { Modal } from '../automation/ui'
import { formatDate, messageOf } from './helpers'
import { WorkbenchIcon } from './WorkbenchIcon'

type Project = { name: string; path: string }
type Review = { action: 'install' | 'update' | 'remove'; target: SkillTarget; location: string; candidate?: SkillCandidate; installed?: InstalledSkill; preview?: SkillPreview }
type CatalogFilter = 'featured' | 'all' | SkillCategoryId

type PreviewMatch = {
  candidateKey: string
  targetKey: string
}

const candidateKey = (candidate: SkillCandidate): string => `${candidate.source}:${candidate.id}`
const targetKey = (target: SkillTarget | null): string => target?.scope === 'global' ? 'global' : target ? `project:${target.project}` : 'project:'

export function SkillsView({ visible, showToast }: { visible: boolean; showToast: (message: string) => void }): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [project, setProject] = useState('')
  const [scope, setScope] = useState<SkillTarget['scope']>('project')
  const [locations, setLocations] = useState<SkillLocations>({ globalPath: '', projects: {} })
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [catalogFilter, setCatalogFilter] = useState<CatalogFilter>('featured')
  const [discoveryMode, setDiscoveryMode] = useState<'curated' | 'search' | 'repository'>('curated')
  const [searchLabel, setSearchLabel] = useState('')
  const [results, setResults] = useState<SkillCandidate[]>([])
  const [selected, setSelected] = useState<SkillCandidate | null>(null)
  const [preview, setPreview] = useState<SkillPreview | null>(null)
  const [previewMatch, setPreviewMatch] = useState<PreviewMatch | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const listVersion = useRef(0)
  const activeTargetKey = useRef('project:')

  const target: SkillTarget | null = scope === 'global' ? { scope: 'global' } : project ? { scope: 'project', project } : null
  const currentTargetKey = targetKey(target)
  const projectName = projects.find((item) => item.path === project)?.name
  const location = scope === 'global'
    ? locations.globalPath
    : projectName && locations.projects[projectName] ? locations.projects[projectName] : project ? `${project}/.agent/skills` : ''
  const currentCategory = SKILL_CATEGORIES.find((category) => category.id === catalogFilter)
  const recommendations = catalogFilter === 'featured'
    ? SKILL_RECOMMENDATIONS.filter((skill) => skill.featured)
    : catalogFilter === 'all' ? SKILL_RECOMMENDATIONS : SKILL_RECOMMENDATIONS.filter((skill) => skill.category === catalogFilter)
  const selectedRecommendation = selected
    ? SKILL_RECOMMENDATIONS.find((skill) => candidateKey(skill) === candidateKey(selected))
    : undefined
  const previewIsCurrent = !!(target && selected && preview?.selected?.id === selected.id && previewMatch?.candidateKey === candidateKey(selected) && previewMatch.targetKey === currentTargetKey)
  const showPreview = !!(selected || preview || busy?.startsWith('preview:'))

  const invalidateDiscovery = useCallback((): void => {
    requestVersion.current += 1
    setSelected(null)
    setPreview(null)
    setPreviewMatch(null)
    setBusy((current) => current === 'search' || current?.startsWith('preview:') || current?.startsWith('update:') ? null : current)
  }, [])

  const loadInstalled = useCallback(async (next: SkillTarget | null): Promise<void> => {
    const version = ++listVersion.current
    if (!next) { setInstalled([]); return }
    try {
      const nextInstalled = await palace.skills.list(next)
      if (version !== listVersion.current) return
      setInstalled(nextInstalled)
      setError(null)
    } catch (reason) {
      if (version === listVersion.current) setError(messageOf(reason))
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    Promise.all([palace.automation.snapshot(), palace.skills.locations()]).then(([snapshot, nextLocations]) => {
      const registered = Object.entries(snapshot.settings.projectPaths).map(([name, path]) => ({ name, path }))
      setProjects(registered)
      setProject((current) => registered.some((item) => item.path === current) ? current : registered[0]?.path || '')
      setLocations(nextLocations)
    }).catch((reason) => setError(messageOf(reason)))
  }, [visible])

  useEffect(() => {
    if (activeTargetKey.current === currentTargetKey) return
    activeTargetKey.current = currentTargetKey
    invalidateDiscovery()
    setReview(null)
  }, [currentTargetKey, invalidateDiscovery])

  useEffect(() => {
    const nextTarget: SkillTarget | null = currentTargetKey === 'global'
      ? { scope: 'global' }
      : currentTargetKey === 'project:' ? null : { scope: 'project', project: currentTargetKey.slice('project:'.length) }
    void loadInstalled(nextTarget)
  }, [currentTargetKey, loadInstalled])

  const chooseProject = async (): Promise<void> => {
    try {
      const chosen = await palace.setup.chooseProject()
      if (!chosen) return
      setProjects((current) => current.some((item) => item.path === chosen.path) ? current : [...current, chosen])
      activeTargetKey.current = `project:${chosen.path}`
      invalidateDiscovery()
      setProject(chosen.path)
      setScope('project')
      const nextLocations = await palace.skills.locations()
      setLocations(nextLocations)
    } catch (reason) { setError(messageOf(reason)) }
  }

  const changeScope = (nextScope: SkillTarget['scope']): void => {
    activeTargetKey.current = nextScope === 'global' ? 'global' : `project:${project}`
    invalidateDiscovery()
    setReview(null)
    setScope(nextScope)
  }

  const changeProject = (nextProject: string): void => {
    activeTargetKey.current = `project:${nextProject}`
    invalidateDiscovery()
    setReview(null)
    setProject(nextProject)
  }

  const search = async (categorySearch?: { query: string; label: string }): Promise<void> => {
    const directSource = !categorySearch && advanced && source.trim() ? source.trim() : ''
    const searchQuery = categorySearch?.query || query.trim()
    const value = directSource || searchQuery
    if (!value) return

    const version = ++requestVersion.current
    const requestedTarget = currentTargetKey
    setBusy('search')
    setError(null)
    setSelected(null)
    setPreview(null)
    setPreviewMatch(null)
    setResults([])
    setDiscoveryMode(directSource ? 'repository' : 'search')
    setSearchLabel(categorySearch?.label || (directSource ? '직접 지정한 저장소' : `“${searchQuery}” 검색 결과`))
    if (categorySearch) {
      setQuery(categorySearch.query)
      setAdvanced(false)
    }

    try {
      if (directSource) {
        const next = await palace.skills.preview(directSource)
        if (version !== requestVersion.current || requestedTarget !== activeTargetKey.current) return
        setResults(next.candidates)
        setPreview(next)
      } else {
        const next = await palace.skills.search(searchQuery)
        if (version !== requestVersion.current || requestedTarget !== activeTargetKey.current) return
        setResults(next)
      }
    } catch (reason) {
      if (version === requestVersion.current && requestedTarget === activeTargetKey.current) setError(messageOf(reason))
    } finally {
      if (version === requestVersion.current && requestedTarget === activeTargetKey.current) setBusy(null)
    }
  }

  const inspect = async (candidate: SkillCandidate): Promise<void> => {
    const key = candidateKey(candidate)
    const version = ++requestVersion.current
    const requestedTarget = currentTargetKey
    setSelected(candidate)
    setPreview(null)
    setPreviewMatch(null)
    setBusy(`preview:${key}`)
    setError(null)
    try {
      const nextPreview = await palace.skills.preview(candidate.source, candidate.id)
      if (version !== requestVersion.current || requestedTarget !== activeTargetKey.current) return
      if (nextPreview.selected?.id !== candidate.id) {
        setError('선택한 Skill의 파일을 확인하지 못했습니다. 출처를 다시 확인해 주세요.')
        return
      }
      setPreview(nextPreview)
      setPreviewMatch({ candidateKey: key, targetKey: requestedTarget })
    } catch (reason) {
      if (version === requestVersion.current && requestedTarget === activeTargetKey.current) setError(messageOf(reason))
    } finally {
      if (version === requestVersion.current && requestedTarget === activeTargetKey.current) setBusy(null)
    }
  }

  const prepareUpdate = async (skill: InstalledSkill): Promise<void> => {
    if (!target) return
    const requestedTarget = target
    const requestedTargetKey = currentTargetKey
    const version = ++requestVersion.current
    setBusy(`update:${skill.id}`)
    setError(null)
    try {
      const nextPreview = await palace.skills.preview(skill.source, skill.id)
      if (version !== requestVersion.current || requestedTargetKey !== activeTargetKey.current) return
      setReview({ action: 'update', target: requestedTarget, location, installed: skill, preview: nextPreview })
    } catch (reason) {
      if (version === requestVersion.current && requestedTargetKey === activeTargetKey.current) setError(messageOf(reason))
    } finally {
      if (version === requestVersion.current && requestedTargetKey === activeTargetKey.current) setBusy(null)
    }
  }

  const prepareRemove = (skill: InstalledSkill): void => {
    if (target) setReview({ action: 'remove', target, location, installed: skill })
  }

  const prepareInstall = (): void => {
    if (target && selected && preview && previewIsCurrent) setReview({ action: 'install', target, location, candidate: selected, preview })
  }

  const confirm = async (): Promise<void> => {
    if (!review) return
    setBusy('confirm'); setError(null)
    try {
      if (review.action === 'install' && review.candidate && review.preview?.selected?.id === review.candidate.id) {
        await palace.skills.install(review.target, review.candidate.source, review.candidate.id, review.preview.revision)
        showToast(`${review.candidate.name} Skill을 설치했습니다`)
      } else if (review.action === 'update' && review.installed && review.preview) {
        await palace.skills.update(review.target, review.installed.id, review.preview.revision)
        showToast(`${review.installed.name} Skill을 업데이트했습니다`)
      } else if (review.action === 'remove' && review.installed) {
        await palace.skills.remove(review.target, review.installed.id)
        showToast(`${review.installed.name} Skill을 제거했습니다`)
      }
      setReview(null)
      if (activeTargetKey.current === targetKey(review.target)) await loadInstalled(review.target)
    } catch (reason) { setError(messageOf(reason)) }
    finally { setBusy(null) }
  }

  const selectCatalogFilter = (filter: CatalogFilter): void => {
    invalidateDiscovery()
    setCatalogFilter(filter)
    setDiscoveryMode('curated')
    setResults([])
    setSearchLabel('')
    setError(null)
  }

  const returnToRecommendations = (): void => {
    invalidateDiscovery()
    setDiscoveryMode('curated')
    setResults([])
    setSearchLabel('')
    setError(null)
  }

  return <section className="wb-page" hidden={!visible} aria-labelledby="skills-title">
    <header className="wb-page-header">
      <div>
        <span className="wb-eyebrow">PROJECT CAPABILITIES</span>
        <h1 id="skills-title">Skills</h1>
        <p>검토한 Skill을 프로젝트의 <code>.agent/skills</code> 또는 현재 사용자의 전역 <code>.agents/skills</code>에 설치하고 업데이트합니다.</p>
      </div>
      <div className="wb-project-picker">
        <select value={scope} onChange={(event) => changeScope(event.target.value as SkillTarget['scope'])} aria-label="Skill 설치 범위">
          <option value="project">프로젝트</option>
          <option value="global">전역 (현재 사용자)</option>
        </select>
        {scope === 'project' && <>
          <select value={project} disabled={!projects.length} onChange={(event) => changeProject(event.target.value)} aria-label="Skill 프로젝트">
            <option value="">{projects.length ? '프로젝트 선택' : '폴더를 연결하세요'}</option>
            {projects.map((item) => <option value={item.path} key={item.path}>{item.name}</option>)}
          </select>
          <button className="wb-button" type="button" onClick={() => void chooseProject()}>폴더 선택</button>
        </>}
      </div>
    </header>
    {error && <div className="wb-error" role="alert"><WorkbenchIcon name="warning" /><span>{error}</span><button type="button" aria-label="오류 닫기" onClick={() => setError(null)}><WorkbenchIcon name="close" size={14} /></button></div>}
    <div className={`wb-skill-layout ${showPreview ? 'has-preview' : 'no-preview'}`}>
      <div className="wb-skill-discovery">
        <div className="wb-search-panel">
          <div className="wb-search-box">
            <WorkbenchIcon name="search" />
            <input value={query} onChange={(event) => { setQuery(event.target.value); invalidateDiscovery() }} onKeyDown={(event) => { if (event.key === 'Enter') void search() }} placeholder="예: Supabase, UI polish, deployment" aria-label="skills.sh Skill 검색" />
            <button className="wb-button wb-button--primary" type="button" disabled={busy === 'search' || (!query.trim() && !(advanced && source.trim()))} onClick={() => void search()}>{busy === 'search' ? '검색 중…' : '검색'}</button>
          </div>
          <button className="wb-disclosure-button" type="button" aria-expanded={advanced} aria-controls="skill-direct-source" onClick={() => { invalidateDiscovery(); setAdvanced((value) => !value) }}><WorkbenchIcon name="chevron" size={14} /> 고급: Git 저장소 직접 지정</button>
          {advanced && <label className="wb-advanced-field" id="skill-direct-source"><span>저장소 URL 또는 로컬 경로</span><input value={source} onChange={(event) => { setSource(event.target.value); invalidateDiscovery() }} onKeyDown={(event) => { if (event.key === 'Enter') void search() }} placeholder="https://github.com/owner/repo" /></label>}
        </div>

        {discoveryMode === 'curated' ? <>
          <div className="wb-catalog-head">
            <div><span className="wb-eyebrow">CURATED FROM SKILLS.SH</span><h2>추천 Skills</h2><p>작업 용도별로 직접 선별한 추천입니다. 순위·개인화 결과가 아니며, 설치 전에 모든 파일을 검토할 수 있습니다.</p></div>
            <div className="wb-catalog-links"><button type="button" onClick={() => void palace.openExternal('https://skills.sh')}><WorkbenchIcon name="external" size={13} /> skills.sh</button><button type="button" onClick={() => void palace.openExternal('https://skills.sh/topic')}><WorkbenchIcon name="external" size={13} /> Topics</button></div>
          </div>
          <nav className="wb-catalog-filters" aria-label="추천 Skill 필터">
            <button type="button" aria-pressed={catalogFilter === 'featured'} onClick={() => selectCatalogFilter('featured')}>추천 <span>{SKILL_RECOMMENDATIONS.filter((skill) => skill.featured).length}</span></button>
            <button type="button" aria-pressed={catalogFilter === 'all'} onClick={() => selectCatalogFilter('all')}>전체 <span>{SKILL_RECOMMENDATIONS.length}</span></button>
            {SKILL_CATEGORIES.map((category) => <button type="button" aria-pressed={catalogFilter === category.id} onClick={() => selectCatalogFilter(category.id)} key={category.id}>{category.label} <span>{SKILL_RECOMMENDATIONS.filter((skill) => skill.category === category.id).length}</span></button>)}
          </nav>
          {currentCategory && <div className="wb-category-context"><span><strong>{currentCategory.label}</strong>{currentCategory.description}</span><button className="wb-button" type="button" disabled={busy === 'search'} onClick={() => void search({ query: currentCategory.query, label: `${currentCategory.label} 더 보기` })}><WorkbenchIcon name="search" size={13} /> 더 검색</button></div>}
          <div className="wb-recommendation-grid" id="skill-discovery-list">
            {recommendations.map((skill) => <RecommendationCard skill={skill} selected={selected ? candidateKey(selected) === candidateKey(skill) : false} busy={busy === `preview:${candidateKey(skill)}`} onInspect={() => void inspect(skill)} onOpen={() => void palace.openExternal(skill.directoryUrl)} key={skill.id} />)}
          </div>
        </> : <>
          <div className="wb-search-results-head"><div><span className="wb-eyebrow">{discoveryMode === 'repository' ? 'GIT REPOSITORY' : 'LIVE SKILLS.SH SEARCH'}</span><h2>{searchLabel}</h2><p>{busy === 'search' ? (discoveryMode === 'repository' ? 'Git 저장소에서 후보를 찾고 있습니다.' : 'skills.sh에서 후보를 찾고 있습니다.') : `${results.length}개의 후보 · 파일을 미리 본 뒤 설치하세요.`}</p></div><button className="wb-button" type="button" onClick={returnToRecommendations}>추천으로 돌아가기</button></div>
          <div className="wb-results-list" id="skill-discovery-list" aria-busy={busy === 'search'}>
            {busy === 'search' && <div className="wb-loading"><span className="spin" /> Skill을 검색하는 중</div>}
            {busy !== 'search' && results.map((candidate) => <article className={`wb-search-result ${selected && candidateKey(selected) === candidateKey(candidate) ? 'is-active' : ''}`} key={candidateKey(candidate)}>
              <span className="wb-result-icon"><WorkbenchIcon name="skills" /></span>
              <span><strong>{candidate.name}</strong><small>{candidate.description || '설명 없음'}</small><em>{candidate.source}{candidate.installs !== undefined ? ` · ${candidate.installs.toLocaleString()}회 설치` : ''}</em></span>
              <button className="wb-button" type="button" disabled={busy === `preview:${candidateKey(candidate)}`} aria-label={`${candidate.name} 미리보기`} onClick={() => void inspect(candidate)}>{busy === `preview:${candidateKey(candidate)}` ? '읽는 중…' : '미리보기'}</button>
            </article>)}
            {busy !== 'search' && results.length === 0 && <div className="wb-list-empty"><WorkbenchIcon name="search" size={24} /><strong>검색 결과가 없습니다</strong><p>다른 검색어를 입력하거나 추천 Skills로 돌아가세요.</p></div>}
          </div>
        </>}
      </div>

      {showPreview && <aside className="wb-skill-preview" aria-label="Skill 미리보기" aria-live="polite">
        {busy?.startsWith('preview:')
          ? <div className="wb-loading"><span className="spin" /> 선택한 Skill을 읽는 중</div>
          : preview ? <>
            <div className="wb-preview-head">
              <div><span className="wb-eyebrow">설치 전 검토</span><h2>{selectedRecommendation?.title || selected?.name || '저장소의 Skills'}</h2><p title={preview.source}>{preview.source}</p></div>
              <div className="wb-preview-actions">{selectedRecommendation && <button className="wb-button" type="button" onClick={() => void palace.openExternal(selectedRecommendation.directoryUrl)}><WorkbenchIcon name="external" size={13} /> skills.sh</button>}{selected && <button className="wb-button wb-button--primary" type="button" disabled={!previewIsCurrent} onClick={prepareInstall}><WorkbenchIcon name="download" /> 설치 검토</button>}</div>
            </div>
            <dl className="wb-preview-facts"><div><dt>Revision</dt><dd>{preview.revision}</dd></div><div><dt>발견된 Skill</dt><dd>{preview.candidates.length}개</dd></div><div><dt>설치 위치</dt><dd>{location || '위치를 선택하세요'}</dd></div></dl>
            {preview.selected
              ? <div className="wb-preview-files">{preview.selected.files.map((file) => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>)}</div>
              : <div className="wb-list-empty"><WorkbenchIcon name="skills" size={24} /><strong>{preview.candidates.length ? '미리 볼 Skill을 선택하세요' : '저장소에서 Skill을 찾지 못했습니다'}</strong><p>{preview.candidates.length ? '왼쪽 검색 결과에서 Skill을 선택하면 파일을 검토할 수 있습니다.' : 'SKILL.md가 있는 저장소 또는 경로인지 확인하세요.'}</p></div>}
          </> : <div className="wb-list-empty"><WorkbenchIcon name="warning" size={24} /><strong>미리보기를 불러오지 못했습니다</strong><p>오류 내용을 확인한 뒤 다시 시도하세요.</p>{selected && <button className="wb-button" type="button" onClick={() => void inspect(selected)}>다시 시도</button>}</div>}
      </aside>}
    </div>

    <section className="wb-installed-section">
      <div className="wb-section-head"><div><h2>{scope === 'global' ? 'Palace가 관리하는 전역 Skill' : '이 프로젝트에 설치됨'}</h2><p><code>{location || '설치 위치를 선택하세요'}</code></p></div><span>{installed.length}개</span></div>
      <div className="wb-installed-grid">
        {installed.map((skill) => <article className="wb-installed-card" key={skill.id}>
          <div><span className="wb-result-icon"><WorkbenchIcon name="skills" /></span><span className={`wb-state-label ${skill.modified ? 'is-warn' : 'is-good'}`}>{skill.modified ? '로컬 수정됨' : '동기화됨'}</span></div>
          <h3>{skill.name}</h3>
          <p>{skill.description || '설명 없음'}</p>
          <small>{skill.source} · {formatDate(skill.installedAt)}</small>
          <div><button className="wb-button" type="button" disabled={!!busy} onClick={() => void prepareUpdate(skill)}><WorkbenchIcon name="refresh" /> 업데이트</button><button className="wb-button wb-button--danger" type="button" disabled={!!busy} onClick={() => prepareRemove(skill)}><WorkbenchIcon name="trash" /> 제거</button></div>
        </article>)}
        {installed.length === 0 && <div className="wb-list-empty"><WorkbenchIcon name="skills" size={24} /><strong>Palace가 관리하는 Skill이 없습니다</strong><p>기존의 추적되지 않은 Skill은 유지되며 이 목록에 표시되지 않습니다.</p></div>}
      </div>
    </section>
    {review && <ReviewModal review={review} busy={busy === 'confirm'} onClose={() => setReview(null)} onConfirm={() => void confirm()} />}
  </section>
}

function RecommendationCard({ skill, selected, busy, onInspect, onOpen }: { skill: RecommendedSkill; selected: boolean; busy: boolean; onInspect: () => void; onOpen: () => void }): JSX.Element {
  return <article className={`wb-recommendation-card ${selected ? 'is-active' : ''}`}>
    <div className="wb-recommendation-card__head"><span className="wb-result-icon"><WorkbenchIcon name="skills" /></span><span><strong>{skill.title}</strong><em>{skill.publisher} · skills.sh</em></span></div>
    <p>{skill.description}</p>
    <div className="wb-recommendation-reason"><span>추천 이유</span>{skill.reason}</div>
    <small title={skill.source}>{skill.source}</small>
    <div className="wb-recommendation-actions"><button className="wb-button wb-button--primary" type="button" disabled={busy} onClick={onInspect}><WorkbenchIcon name="files" size={13} /> {busy ? '읽는 중…' : '미리보기'}</button><button className="wb-button" type="button" aria-label={`${skill.title} skills.sh에서 열기`} onClick={onOpen}><WorkbenchIcon name="external" size={13} /> skills.sh</button></div>
  </article>
}

function ReviewModal({ review, busy, onClose, onConfirm }: { review: Review; busy: boolean; onClose: () => void; onConfirm: () => void }): JSX.Element {
  const title = review.action === 'install' ? 'Skill 설치 검토' : review.action === 'update' ? 'Skill 업데이트 검토' : 'Skill 제거 확인'
  const name = review.candidate?.name || review.installed?.name || 'Skill'
  return <Modal
    title={title}
    description={`${name} · ${review.location}`}
    onClose={onClose}
    width="large"
    footer={<><button className="auto-button" type="button" onClick={onClose}>취소</button><button className={`auto-button ${review.action === 'remove' ? 'auto-button--danger' : 'auto-button--primary'}`} type="button" disabled={busy} onClick={onConfirm}>{busy ? '처리 중…' : review.action === 'install' ? '검토하고 설치' : review.action === 'update' ? '검토하고 업데이트' : '제거'}</button></>}
  >
    {review.action === 'remove'
      ? <div className="wb-warning-box"><WorkbenchIcon name="warning" /><p><strong>{name}</strong>의 추적된 설치 파일을 제거합니다. 수정되었거나 추적되지 않은 파일이 있으면 안전을 위해 제거가 중단됩니다.</p></div>
      : <><div className="wb-review-source"><span>출처</span><strong>{review.preview?.source}</strong><small>고정 revision: {review.preview?.revision}</small></div><div className="wb-review-files">{review.preview?.selected?.files.map((file) => <details key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>)}</div></>}
  </Modal>
}
