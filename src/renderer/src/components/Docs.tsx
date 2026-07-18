import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'
import { palace } from '../api'
import type { AppView } from '../../../shared/types'

export function Docs({ app }: { app: AppView }): JSX.Element {
  const m = app.manifest
  const docPaths = [m.readme ?? 'README.md', ...(m.extraDocs ?? [])]
  const [active, setActive] = useState(docPaths[0])
  const [html, setHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (app.installState !== 'installed') return
    setLoading(true)
    palace
      .readDocs(m.id, active)
      .then((r) => setHtml(r ? DOMPurify.sanitize(r.html, { ADD_ATTR: ['target'] }) : null))
      .finally(() => setLoading(false))
  }, [m.id, active, app.installState])

  if (app.installState !== 'installed') {
    return <div className="pane">
      <div className="empty">문서는 앱을 설치한 뒤 README 를 읽어 보여줍니다.</div>
    </div>
  }

  const onClick = (e: React.MouseEvent): void => {
    const a = (e.target as HTMLElement).closest('a')
    if (a) {
      const href = a.getAttribute('href') || ''
      if (href.startsWith('http')) {
        e.preventDefault()
        palace.openExternal(href)
      }
    }
  }

  return (
    <div className="pane">
      {docPaths.length > 1 && (
        <div className="row" style={{ marginBottom: 14 }}>
          {docPaths.map((p) => (
            <button key={p} className="btn ghost sm" onClick={() => setActive(p)} style={active === p ? { color: 'var(--text)', background: 'var(--bg-3)' } : undefined}>
              {p}
            </button>
          ))}
        </div>
      )}
      {loading && <div className="empty"><span className="spin" /> 불러오는 중…</div>}
      {!loading && !html && <div className="empty">{active} 를 찾을 수 없습니다.</div>}
      {!loading && html && <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  )
}
