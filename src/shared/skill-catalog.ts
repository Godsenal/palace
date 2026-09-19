import type { SkillCandidate } from './workbench'

// Editorial selections, not a live leaderboard or a claim of project-specific suitability.
// Source manifests and compatibility with the preview installer reviewed on 2026-09-20.
export const SKILL_CATEGORIES = [
  { id: 'frontend', label: '프론트엔드', query: 'react', description: 'React 성능과 컴포넌트 설계' },
  { id: 'design', label: '디자인 · UI', query: 'design', description: '화면 설계, 접근성과 UI 검토' },
  { id: 'database', label: '백엔드 · DB', query: 'postgres', description: '스키마, SQL과 데이터베이스 성능' },
  { id: 'testing', label: '테스트 · 디버깅', query: 'testing', description: '브라우저 테스트와 원인 분석' },
  { id: 'workflow', label: '에이전트 · 워크플로', query: 'agent workflow', description: '스킬 탐색과 에이전트 작업 방식' },
  { id: 'documents', label: '문서 · 협업', query: 'documentation', description: '기술 문서, 제안서와 설계 명세' }
] as const

export type SkillCategoryId = typeof SKILL_CATEGORIES[number]['id']

export interface RecommendedSkill extends SkillCandidate {
  title: string
  publisher: string
  category: SkillCategoryId
  reason: string
  featured: boolean
  directoryUrl: string
}

export const SKILL_RECOMMENDATIONS: readonly RecommendedSkill[] = [
  {
    id: 'vercel-react-best-practices', name: 'vercel-react-best-practices',
    source: 'https://github.com/vercel-labs/agent-skills.git', path: 'skills/react-best-practices',
    title: 'React 성능 가이드', publisher: 'Vercel', category: 'frontend', featured: true,
    description: 'React·Next.js의 데이터 로딩, 번들 크기와 렌더링 성능을 점검합니다.',
    reason: 'React 화면을 만들거나 느린 페이지를 개선할 때',
    directoryUrl: 'https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices'
  },
  {
    id: 'frontend-design', name: 'frontend-design',
    source: 'https://github.com/anthropics/skills.git', path: 'skills/frontend-design',
    title: '프론트엔드 디자인', publisher: 'Anthropic', category: 'design', featured: true,
    description: '제품에 맞는 시각적 방향, 타이포그래피와 개성 있는 UI를 설계합니다.',
    reason: '새 화면의 디자인 방향을 잡거나 기존 UI를 다듬을 때',
    directoryUrl: 'https://skills.sh/anthropics/skills/frontend-design'
  },
  {
    id: 'supabase-postgres-best-practices', name: 'supabase-postgres-best-practices',
    source: 'https://github.com/supabase/agent-skills.git', path: 'skills/supabase-postgres-best-practices',
    title: 'Postgres 실무 가이드', publisher: 'Supabase', category: 'database', featured: true,
    description: 'Postgres 스키마, 마이그레이션, RLS와 쿼리 성능을 검토합니다.',
    reason: 'Supabase 또는 Postgres의 테이블·SQL을 변경할 때',
    directoryUrl: 'https://skills.sh/supabase/agent-skills/supabase-postgres-best-practices'
  },
  {
    id: 'webapp-testing', name: 'webapp-testing',
    source: 'https://github.com/anthropics/skills.git', path: 'skills/webapp-testing',
    title: '웹 앱 브라우저 테스트', publisher: 'Anthropic', category: 'testing', featured: true,
    description: 'Playwright로 로컬 웹 앱을 조작하고 스크린샷과 브라우저 로그를 확인합니다.',
    reason: '화면의 실제 동작을 검증할 때 · Playwright 환경 필요',
    directoryUrl: 'https://skills.sh/anthropics/skills/webapp-testing'
  },
  {
    id: 'find-skills', name: 'find-skills',
    source: 'https://github.com/vercel-labs/skills.git', path: 'skills/find-skills',
    title: '필요한 스킬 찾기', publisher: 'Vercel', category: 'workflow', featured: true,
    description: '작업에 맞는 스킬을 검색하고 출처와 설치 방법을 안내합니다.',
    reason: '어떤 스킬을 추가해야 할지 에이전트와 함께 찾을 때',
    directoryUrl: 'https://skills.sh/vercel-labs/skills/find-skills'
  },
  {
    id: 'doc-coauthoring', name: 'doc-coauthoring',
    source: 'https://github.com/anthropics/skills.git', path: 'skills/doc-coauthoring',
    title: '기술 문서 함께 쓰기', publisher: 'Anthropic', category: 'documents', featured: true,
    description: '맥락 수집, 초안 개선과 독자 검토를 거쳐 구조화된 문서를 작성합니다.',
    reason: '기술 명세, 제안서나 의사결정 문서를 정리할 때',
    directoryUrl: 'https://skills.sh/anthropics/skills/doc-coauthoring'
  },
  {
    id: 'vercel-composition-patterns', name: 'vercel-composition-patterns',
    source: 'https://github.com/vercel-labs/agent-skills.git', path: 'skills/composition-patterns',
    title: 'React 컴포넌트 설계', publisher: 'Vercel', category: 'frontend', featured: false,
    description: '합성 패턴과 상태 분리로 재사용하기 쉬운 React 컴포넌트를 만듭니다.',
    reason: '복잡한 props를 정리하거나 컴포넌트 라이브러리를 설계할 때',
    directoryUrl: 'https://skills.sh/vercel-labs/agent-skills/vercel-composition-patterns'
  },
  {
    id: 'web-design-guidelines', name: 'web-design-guidelines',
    source: 'https://github.com/vercel-labs/agent-skills.git', path: 'skills/web-design-guidelines',
    title: '웹 UI 품질 점검', publisher: 'Vercel', category: 'design', featured: false,
    description: '웹 인터페이스 가이드라인을 기준으로 UI 코드와 접근성을 검토합니다.',
    reason: '완성한 화면의 사용성과 접근성을 점검할 때',
    directoryUrl: 'https://skills.sh/vercel-labs/agent-skills/web-design-guidelines'
  },
  {
    id: 'systematic-debugging', name: 'systematic-debugging',
    source: 'https://github.com/obra/superpowers.git', path: 'skills/systematic-debugging',
    title: '체계적인 디버깅', publisher: 'obra · 커뮤니티', category: 'testing', featured: false,
    description: '재현과 근거 수집을 통해 버그와 테스트 실패의 원인을 좁힙니다.',
    reason: '추측으로 수정하기 전에 실패 원인을 파악할 때',
    directoryUrl: 'https://skills.sh/obra/superpowers/systematic-debugging'
  },
  {
    id: 'skill-creator', name: 'skill-creator',
    source: 'https://github.com/anthropics/skills.git', path: 'skills/skill-creator',
    title: '나만의 스킬 만들기', publisher: 'Anthropic', category: 'workflow', featured: false,
    description: '새 스킬을 작성하고 기존 스킬의 지침·트리거와 평가를 개선합니다.',
    reason: '반복하는 작업 방식을 재사용 가능한 스킬로 정리할 때',
    directoryUrl: 'https://skills.sh/anthropics/skills/skill-creator'
  }
]
