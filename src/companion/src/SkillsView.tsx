import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { SKILL_CATEGORIES, SKILL_RECOMMENDATIONS, type SkillCategoryId } from '../../shared/skill-catalog'
import type { InstalledSkill, SkillCandidate, SkillLocations, SkillPreview, SkillTarget } from '../../shared/workbench'
import type { CompanionApi } from './api'

type DiscoveryMode = 'search' | 'repository'
type RecommendationFilter = 'featured' | 'all' | SkillCategoryId
type DiscoveryRequest = { mode: DiscoveryMode; value: string; label: string }
type Review =
  | { action: 'install'; target: SkillTarget; path: string; candidate: SkillCandidate; preview: SkillPreview }
  | { action: 'update'; target: SkillTarget; path: string; installed: InstalledSkill; preview: SkillPreview }
  | { action: 'remove'; target: SkillTarget; path: string; installed: InstalledSkill }

type Props = {
  api: CompanionApi
  active: boolean
  showToast: (message: string) => void
}

export function SkillsView({ api, active, showToast }: Props): JSX.Element {
  const [locations, setLocations] = useState<SkillLocations | null>(null)
  const [scope, setScope] = useState<SkillTarget['scope']>('project')
  const [project, setProject] = useState('')
  const [installed, setInstalled] = useState<InstalledSkill[]>([])
  const [mode, setMode] = useState<DiscoveryMode>('search')
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [recommendationFilter, setRecommendationFilter] = useState<RecommendationFilter>('featured')
  const [showSearchResults, setShowSearchResults] = useState(false)
  const [resultLabel, setResultLabel] = useState('')
  const [results, setResults] = useState<SkillCandidate[]>([])
  const [selected, setSelected] = useState<SkillCandidate | null>(null)
  const [preview, setPreview] = useState<SkillPreview | null>(null)
  const [previewAction, setPreviewAction] = useState<{ kind: 'install' } | { kind: 'update'; installed: InstalledSkill } | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const locationsVersion = useRef(0)
  const listVersion = useRef(0)
  const searchVersion = useRef(0)
  const previewVersion = useRef(0)
  const targetKeyRef = useRef('')
  const previewSection = useRef<HTMLElement>(null)

  const target = useMemo<SkillTarget | null>(() => scope === 'global' ? { scope: 'global' } : project ? { scope: 'project', project } : null, [scope, project])
  const targetKey = target?.scope === 'global' ? 'global' : target ? `project:${target.project}` : 'project:'
  targetKeyRef.current = targetKey
  const targetPath = target?.scope === 'global' ? locations?.globalPath || '' : target ? locations?.projects[target.project] || '' : ''
  const projectNames = useMemo(() => Object.keys(locations?.projects || {}).sort((left, right) => left.localeCompare(right)), [locations])
  const activeCategory = SKILL_CATEGORIES.find((category) => category.id === recommendationFilter)
  const visibleRecommendations = useMemo(() => {
    if (recommendationFilter === 'featured') return SKILL_RECOMMENDATIONS.filter((skill) => skill.featured)
    if (recommendationFilter === 'all') return SKILL_RECOMMENDATIONS
    return SKILL_RECOMMENDATIONS.filter((skill) => skill.category === recommendationFilter)
  }, [recommendationFilter])

  useEffect(() => {
    if (active && previewAction) previewSection.current?.scrollIntoView({ block: 'start' })
  }, [active, previewAction])

  const loadLocations = useCallback(async (): Promise<void> => {
    const version = ++locationsVersion.current
    setBusy((current) => current || 'locations')
    setError('')
    try {
      const next = await api.skillsLocations()
      if (version !== locationsVersion.current) return
      setLocations(next)
      setProject((current) => current && next.projects[current] ? current : Object.keys(next.projects).sort()[0] || '')
    } catch (reason) {
      if (version === locationsVersion.current) setError(messageOf(reason))
    } finally {
      if (version === locationsVersion.current) setBusy((current) => current === 'locations' ? '' : current)
    }
  }, [api])

  useEffect(() => {
    if (!active) return
    void loadLocations()
    return () => { locationsVersion.current += 1 }
  }, [active, loadLocations])

  const loadInstalled = useCallback(async (requestedTarget: SkillTarget): Promise<void> => {
    const version = ++listVersion.current
    setInstalled([])
    setBusy((current) => current || 'list')
    try {
      const next = await api.listSkills(requestedTarget)
      if (version === listVersion.current) setInstalled(next)
    } catch (reason) {
      if (version === listVersion.current) setError(messageOf(reason))
    } finally {
      if (version === listVersion.current) setBusy((current) => current === 'list' ? '' : current)
    }
  }, [api])

  useEffect(() => {
    listVersion.current += 1
    previewVersion.current += 1
    searchVersion.current += 1
    setBusy('')
    setSelected(null)
    setPreview(null)
    setPreviewAction(null)
    setReview(null)
    setResults([])
    setShowSearchResults(false)
    setResultLabel('')
    setError('')
    if (!active || !target || !locations) {
      setInstalled([])
      return
    }
    void loadInstalled(target)
  }, [active, targetKey, locations, loadInstalled])

  const resetDiscovery = (): void => {
    searchVersion.current += 1
    previewVersion.current += 1
    setResults([])
    setShowSearchResults(false)
    setResultLabel('')
    setSelected(null)
    setPreview(null)
    setPreviewAction(null)
    setReview(null)
    setBusy((current) => current === 'discover' || current.startsWith('preview:') || current.startsWith('update:') ? '' : current)
    setError('')
  }

  const discover = async (request?: DiscoveryRequest): Promise<void> => {
    const requestMode = request?.mode || mode
    const value = (request?.value || (requestMode === 'search' ? query : source)).trim()
    if (!value) return
    const version = ++searchVersion.current
    const scopeAtRequest = targetKey
    previewVersion.current += 1
    if (request) {
      setMode(requestMode)
      if (requestMode === 'search') setQuery(value)
      else setSource(value)
    }
    setBusy('discover')
    setError('')
    setResults([])
    setSelected(null)
    setPreview(null)
    setPreviewAction(null)
    setReview(null)
    setShowSearchResults(true)
    setResultLabel(request?.label || (requestMode === 'search' ? `skills.sh 검색 결과 · “${value}”` : `GitHub 저장소 검색 결과 · ${value}`))
    try {
      const next = requestMode === 'search' ? await api.searchSkills(value) : (await api.previewSkill(value)).candidates
      if (version !== searchVersion.current || scopeAtRequest !== targetKeyRef.current) return
      setResults(next)
      if (!next.length) setError(requestMode === 'search' ? 'skills.sh에서 일치하는 Skill을 찾지 못했습니다.' : '저장소에서 SKILL.md를 찾지 못했습니다.')
    } catch (reason) {
      if (version === searchVersion.current && scopeAtRequest === targetKeyRef.current) setError(messageOf(reason))
    } finally {
      if (version === searchVersion.current) setBusy((current) => current === 'discover' ? '' : current)
    }
  }

  const inspect = async (candidate: SkillCandidate): Promise<void> => {
    const version = ++previewVersion.current
    const scopeAtRequest = targetKey
    setSelected(candidate)
    setPreview(null)
    setPreviewAction({ kind: 'install' })
    setBusy(`preview:${candidate.id}`)
    setError('')
    try {
      const next = await api.previewSkill(candidate.source, candidate.id)
      if (version !== previewVersion.current || scopeAtRequest !== targetKeyRef.current) return
      setPreview(next)
    } catch (reason) {
      if (version === previewVersion.current && scopeAtRequest === targetKeyRef.current) {
        setPreviewAction(null)
        setError(messageOf(reason))
      }
    } finally {
      if (version === previewVersion.current) setBusy((current) => current === `preview:${candidate.id}` ? '' : current)
    }
  }

  const prepareUpdate = async (skill: InstalledSkill): Promise<void> => {
    if (skill.modified) return
    const version = ++previewVersion.current
    const scopeAtRequest = targetKey
    setSelected(null)
    setPreview(null)
    setPreviewAction({ kind: 'update', installed: skill })
    setBusy(`update:${skill.id}`)
    setError('')
    try {
      const next = await api.previewSkill(skill.source, skill.id)
      if (version !== previewVersion.current || scopeAtRequest !== targetKeyRef.current) return
      setPreview(next)
    } catch (reason) {
      if (version === previewVersion.current && scopeAtRequest === targetKeyRef.current) {
        setPreviewAction(null)
        setError(messageOf(reason))
      }
    } finally {
      if (version === previewVersion.current) setBusy((current) => current === `update:${skill.id}` ? '' : current)
    }
  }

  const openReview = (): void => {
    if (!target || !targetPath || !preview?.selected || !previewAction) return
    if (previewAction.kind === 'install' && selected) {
      setReview({ action: 'install', target, path: appendPath(targetPath, selected.id), candidate: selected, preview })
    } else if (previewAction.kind === 'update') {
      setReview({ action: 'update', target, path: previewAction.installed.path, installed: previewAction.installed, preview })
    }
  }

  const confirm = async (): Promise<void> => {
    if (!review) return
    const pending = review
    setBusy('confirm')
    setError('')
    try {
      if (pending.action === 'install') {
        await api.installSkill(pending.target, pending.candidate.source, pending.candidate.id, pending.preview.revision)
        showToast(`${pending.candidate.name} Skill을 설치했습니다`)
      } else if (pending.action === 'update') {
        await api.updateSkill(pending.target, pending.installed.id, pending.preview.revision)
        showToast(`${pending.installed.name} Skill을 업데이트했습니다`)
      } else {
        await api.removeSkill(pending.target, pending.installed.id)
        showToast(`${pending.installed.name} Skill을 제거했습니다`)
      }
      setReview(null)
      setPreview(null)
      setPreviewAction(null)
      setSelected(null)
      const pendingTargetKey = pending.target.scope === 'global' ? 'global' : `project:${pending.target.project}`
      if (targetKeyRef.current === pendingTargetKey) await loadInstalled(pending.target)
    } catch (reason) {
      setReview(null)
      setError(messageOf(reason))
    } finally {
      setBusy((current) => current === 'confirm' ? '' : current)
    }
  }

  const previewName = previewAction?.kind === 'update' ? previewAction.installed.name : selected?.name
  const actionLabel = previewAction?.kind === 'update' ? '업데이트 확인' : '설치 확인'
  const selectedKey = selected ? skillKey(selected) : ''

  return <section className="page skills-page" aria-labelledby="skills-title">
    <header className="page-header"><div><p className="eyebrow">OMP CAPABILITIES</p><h1 id="skills-title">Skills</h1><p>추천 스킬을 둘러보고, 파일을 미리 본 뒤 설치하세요.</p></div></header>

    <details className="skill-target-panel" open={!target}>
      <summary><span><small>설치 대상</small><strong>{scope === 'global' ? 'Global · 현재 사용자' : `Project · ${project || '프로젝트 선택'}`}</strong></span><span>변경 <b aria-hidden="true">⌄</b></span></summary>
      <div className="skill-target-controls">
      <div className="scope-switch" role="radiogroup" aria-label="Skill 설치 범위">
        <button type="button" role="radio" aria-checked={scope === 'project'} className={scope === 'project' ? 'is-active' : ''} onClick={() => setScope('project')}>Project</button>
        <button type="button" role="radio" aria-checked={scope === 'global'} className={scope === 'global' ? 'is-active' : ''} onClick={() => setScope('global')}>Global</button>
      </div>
      {scope === 'project' && <label className="field"><span>등록된 프로젝트</span><select value={project} disabled={!projectNames.length} onChange={(event) => setProject(event.target.value)}><option value="">프로젝트 선택</option>{projectNames.map((name) => <option value={name} key={name}>{name}</option>)}</select></label>}
      <div className="install-path"><span>설치 경로</span><code>{targetPath || (scope === 'project' ? '등록된 프로젝트가 없습니다.' : '경로를 불러오는 중…')}</code></div>
      {scope === 'global' && <div className="skill-scope-warning"><strong>현재 사용자의 모든 새 OMP 세션에 적용됩니다.</strong><span>프로젝트 프로필에는 동기화되지 않습니다. 이미 실행 중인 세션은 자동으로 다시 불러오지 않으므로 새로 시작하거나 재시작하세요.</span></div>}
      </div>
    </details>

    {error && <div className="inline-error" role="alert"><span aria-hidden="true">!</span><span>{error}</span><button type="button" aria-label="오류 닫기" onClick={() => setError('')}>×</button></div>}

    <section className="skill-discovery" aria-label="Skill 찾기">
      <div className="scope-switch discovery-switch" role="tablist" aria-label="Skill 찾기 방식">
        <button type="button" role="tab" aria-selected={mode === 'search'} className={mode === 'search' ? 'is-active' : ''} onClick={() => { setMode('search'); resetDiscovery() }}>skills.sh 검색</button>
        <button type="button" role="tab" aria-selected={mode === 'repository'} className={mode === 'repository' ? 'is-active' : ''} onClick={() => { setMode('repository'); resetDiscovery() }}>GitHub 저장소</button>
      </div>
      <div className="skill-search-row">
        {mode === 'search' ? <label className="field"><input aria-label="skills.sh 검색어" type="search" value={query} onChange={(event) => { setQuery(event.target.value); resetDiscovery() }} onKeyDown={(event) => { if (event.key === 'Enter') void discover() }} placeholder="예: Supabase, UI polish" /></label> : <label className="field"><input aria-label="Git 저장소 URL 또는 로컬 경로" className="mono" autoCapitalize="none" spellCheck={false} value={source} onChange={(event) => { setSource(event.target.value); resetDiscovery() }} onKeyDown={(event) => { if (event.key === 'Enter') void discover() }} placeholder="owner/repo 또는 GitHub URL" /></label>}
        <button className="button primary" type="button" disabled={busy === 'discover' || (mode === 'search' ? !query.trim() : !source.trim())} onClick={() => void discover()}>{busy === 'discover' ? '찾는 중…' : mode === 'search' ? '검색' : '읽기'}</button>
      </div>
      {mode === 'repository' && <small className="skill-discovery-note">자격 증명이 없는 GitHub 저장소 루트나 이 Mac의 로컬 Git 경로를 입력하세요.</small>}
    </section>

    {!showSearchResults && <section className="skill-recommendations" aria-labelledby="skill-recommendations-title">
      <div className="recommendation-heading">
        <div><span className="eyebrow">CURATED STARTERS</span><strong id="skill-recommendations-title">추천 Skills</strong><small>작업 목적에 맞춰 고른 출발점입니다. 순위나 개인화 결과가 아닙니다.</small></div>
        <nav className="recommendation-links" aria-label="Skill 디렉터리 링크">
          <a href="https://skills.sh" target="_blank" rel="noopener noreferrer">skills.sh ↗</a>
          <a href="https://skills.sh/topic" target="_blank" rel="noopener noreferrer">Topics ↗</a>
        </nav>
      </div>
      <div className="skill-filter-chips" aria-label="추천 Skill 필터 — 좌우로 넘겨보세요">
        <button type="button" className={recommendationFilter === 'featured' ? 'is-active' : ''} aria-pressed={recommendationFilter === 'featured'} onClick={() => { setRecommendationFilter('featured'); resetDiscovery() }}>추천 <span>{SKILL_RECOMMENDATIONS.filter((skill) => skill.featured).length}</span></button>
        <button type="button" className={recommendationFilter === 'all' ? 'is-active' : ''} aria-pressed={recommendationFilter === 'all'} onClick={() => { setRecommendationFilter('all'); resetDiscovery() }}>전체 <span>{SKILL_RECOMMENDATIONS.length}</span></button>
        {SKILL_CATEGORIES.map((category) => <button type="button" className={recommendationFilter === category.id ? 'is-active' : ''} aria-pressed={recommendationFilter === category.id} key={category.id} onClick={() => { setRecommendationFilter(category.id); resetDiscovery() }}>{category.label} <span>{SKILL_RECOMMENDATIONS.filter((skill) => skill.category === category.id).length}</span></button>)}
      </div>
      {activeCategory && <div className="recommendation-summary">
        <div><strong>{activeCategory.label}</strong><small>{activeCategory.description}</small></div>
        <button className="text-button" type="button" disabled={busy === 'discover'} onClick={() => void discover({ mode: 'search', value: activeCategory.query, label: `${activeCategory.label} · skills.sh 검색 결과` })}>이 분야 더 찾기</button>
      </div>}
      <div className="recommendation-grid">{visibleRecommendations.map((skill) => <article className={`skill-recommendation-card ${selectedKey === skillKey(skill) ? 'is-active' : ''}`} key={skillKey(skill)}>
        <div className="recommendation-card-meta"><span>{SKILL_CATEGORIES.find((category) => category.id === skill.category)?.label}</span><strong>{skill.publisher}</strong></div>
        <h2>{skill.title}</h2>
        <p className="recommendation-purpose">{skill.description}</p>
        <div className="recommendation-source"><code>{skill.source.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')}</code></div>
        <p className="recommendation-reason"><strong>추천 이유</strong><span>{skill.reason}</span></p>
        <div className="recommendation-actions"><button className="button primary" type="button" onClick={() => void inspect(skill)}>미리보기</button><a className="button" href={skill.directoryUrl} target="_blank" rel="noopener noreferrer">상세 보기 ↗</a></div>
      </article>)}</div>
    </section>}

    {showSearchResults && <section className="skill-results" aria-labelledby="skill-results-title">
      <div className="skill-section-head"><div><span className="eyebrow">SEARCHED RESULTS</span><strong id="skill-results-title">{resultLabel}</strong><small>{busy === 'discover' ? 'skills.sh 또는 지정한 저장소에서 찾는 중입니다.' : `${results.length}개 · 추천 목록과 별도의 실시간 결과입니다.`}</small></div><button className="button" type="button" onClick={resetDiscovery}>추천으로 돌아가기</button></div>
      {busy === 'discover' ? <div className="skill-loading"><span className="spinner" />Skill을 찾는 중…</div> : results.length > 0 ? <div className="skill-result-list">{results.map((candidate) => <button type="button" className={`skill-result ${selectedKey === skillKey(candidate) ? 'is-active' : ''}`} key={skillKey(candidate)} onClick={() => void inspect(candidate)}><span className="skill-glyph">S</span><span><strong>{candidate.name}</strong><small>{candidate.description || '설명 없음'}</small><em>{candidate.path}{candidate.installs === undefined ? '' : ` · ${candidate.installs.toLocaleString()}회 설치`}</em></span><b aria-hidden="true">›</b></button>)}</div> : <div className="compact-empty">검색 결과가 없습니다. 검색어를 바꾸거나 추천 목록으로 돌아가세요.</div>}
    </section>}

    {(previewAction || preview) && <section ref={previewSection} className="skill-preview" aria-labelledby="skill-preview-title">
      <div className="skill-section-head"><div><span className="eyebrow">INSTALL PREVIEW</span><strong id="skill-preview-title">{previewName || 'Skill 미리보기'}</strong></div>{preview?.selected && <button className="button primary" type="button" disabled={!target || !targetPath || Boolean(busy)} onClick={openReview}>{actionLabel}</button>}</div>
      {busy.startsWith('preview:') || busy.startsWith('update:') ? <div className="skill-loading"><span className="spinner" />파일을 안전하게 읽는 중…</div> : preview ? <>
        <dl className="preview-facts"><div><dt>Source</dt><dd>{preview.source}</dd></div><div><dt>Revision</dt><dd>{preview.revision}</dd></div><div><dt>Destination</dt><dd>{previewAction?.kind === 'update' ? previewAction.installed.path : selected ? appendPath(targetPath, selected.id) : targetPath}</dd></div><div><dt>Size</dt><dd>{formatBytes(preview.selected?.bytes || 0)}</dd></div></dl>
        {preview.selected ? <div className="preview-files">{preview.selected.files.map((file, index) => <details open={index === 0} key={file.path}><summary>{file.path}</summary><pre>{file.content}</pre></details>)}</div> : <div className="compact-empty">설치할 Skill을 선택하면 파일 내용이 표시됩니다.</div>}
      </> : null}
    </section>}

    <section className="installed-skills" aria-labelledby="installed-title">
      <div className="skill-section-head"><div><strong id="installed-title">Companion이 관리하는 Skills</strong><small>{target?.scope === 'global' ? 'Global · 현재 사용자' : project || 'Project를 선택하세요'} · {installed.length}개</small></div><button className="button" type="button" disabled={Boolean(busy)} onClick={() => void loadLocations()}>새로고침</button></div>
      {busy === 'list' || busy === 'locations' ? <div className="skill-loading"><span className="spinner" />설치 목록을 읽는 중…</div> : !target ? <div className="compact-empty">등록된 프로젝트를 선택하거나 Global로 전환하세요.</div> : installed.length === 0 ? <div className="compact-empty">이 대상에서 Companion이 관리하는 설치 기록이 없습니다. 기존 폴더나 다른 도구로 설치한 Skill은 건드리지 않습니다.</div> : <div className="installed-list">{installed.map((skill) => <article className="installed-card" key={skill.id}><div className="card-heading"><div><h2>{skill.name}</h2><span className="mono muted">{skill.path}</span></div><span className={`status-chip ${skill.modified ? 'warn' : 'good'}`}>{skill.modified ? '로컬 변경 감지' : '추적됨'}</span></div><p>{skill.description || '설명 없음'}</p><div className="installed-meta"><span>{skill.source}</span><span className="mono">{skill.revision.length > 12 ? skill.revision.slice(0, 12) : skill.revision}</span></div>{skill.modified && <div className="skill-modified-warning"><strong>수정되었거나 추적되지 않은 파일이 있습니다.</strong><span>로컬 변경을 보존하기 위해 업데이트와 제거를 막았습니다. Mac에서 변경을 별도로 보관하고 원래 상태로 복원한 뒤 다시 시도하세요.</span></div>}<div className="card-actions"><button className="button" type="button" disabled={Boolean(busy) || skill.modified} onClick={() => void prepareUpdate(skill)}>업데이트 검토</button><button className="button danger-ghost" type="button" disabled={Boolean(busy) || skill.modified} onClick={() => target && setReview({ action: 'remove', target, path: skill.path, installed: skill })}>제거</button></div></article>)}</div>}
    </section>

    {review && <SkillReviewModal review={review} busy={busy === 'confirm'} onClose={() => setReview(null)} onConfirm={() => void confirm()} />}
  </section>
}

function SkillReviewModal({ review, busy, onClose, onConfirm }: { review: Review; busy: boolean; onClose: () => void; onConfirm: () => void }): JSX.Element {
  const titleId = useId()
  const name = review.action === 'install' ? review.candidate.name : review.installed.name
  const action = review.action === 'install' ? '설치' : review.action === 'update' ? '업데이트' : '제거'
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}><section className="modal skill-review-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}><header><div><h2 id={titleId}>{name} {action}</h2><p>대상과 경로를 마지막으로 확인하세요.</p></div><button className="icon-button" type="button" aria-label="닫기" disabled={busy} onClick={onClose}>×</button></header><div className="modal-body"><div className="review-target"><span>{review.target.scope === 'global' ? 'Global · 현재 사용자' : `Project · ${review.target.project}`}</span><code>{review.path}</code></div>{review.action === 'remove' ? <div className="warning-panel"><span><strong>설치된 파일을 제거합니다.</strong><br />이 작업은 설치 경로의 Skill 파일을 삭제합니다. 설치 후 변경된 파일이 있으면 제거하지 않고 보존합니다.</span></div> : <><div className="notice"><strong>검토한 revision만 사용합니다.</strong><span className="mono">{review.preview.revision}</span></div><div className="review-file-summary">{review.preview.selected?.files.length || 0}개 파일 · {formatBytes(review.preview.selected?.bytes || 0)}</div></>}</div><footer><span /><div><button className="button" type="button" disabled={busy} onClick={onClose}>취소</button><button className={`button ${review.action === 'remove' ? 'danger' : 'primary'}`} type="button" disabled={busy} onClick={onConfirm}>{busy ? '처리 중…' : `${action} 확인`}</button></div></footer></section></div>
}


function skillKey(skill: SkillCandidate): string {
  return `${skill.source}:${skill.id}`
}


function appendPath(root: string, child: string): string {
  return `${root.replace(/\/$/, '')}/${child}`
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

