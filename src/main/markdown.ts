import { marked } from 'marked'

/**
 * 마크다운 → HTML. 최종 새니타이즈는 renderer(DOMPurify)에서 한다.
 * repoBase 가 있으면 상대 링크/이미지를 GitHub raw/blob 로 절대화 시도.
 */
export function renderMarkdown(md: string, repoBase?: string): string {
  const html = marked.parse(md, { async: false, gfm: true, breaks: false }) as string
  if (!repoBase) return html
  const rawBase = repoBase.replace(/\.git$/, '').replace('github.com', 'raw.githubusercontent.com')
  // src="./x" / src="x" (http 아닌) → raw base. 완벽하진 않지만 흔한 케이스 커버.
  return html
    .replace(/src="(?!https?:|data:)\.?\/?([^"]+)"/g, `src="${rawBase}/HEAD/$1"`)
    .replace(/href="(?!https?:|#|mailto:)\.?\/?([^"]+)"/g, `href="${repoBase.replace(/\.git$/, '')}/blob/HEAD/$1"`)
}
