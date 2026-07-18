import { useRef } from 'react'
import { palace } from '../api'
import type { AppView } from '../../../shared/types'

// webview 는 표준 JSX 타입에 없어 캐스팅으로 사용.
const WebView = 'webview' as unknown as React.FC<Record<string, unknown>>

export function DashboardEmbed({ app, onStart }: { app: AppView; onStart: () => void }): JSX.Element {
  const ref = useRef<HTMLElement | null>(null)
  const url = app.manifest.dashboard?.url
  const live = app.runState === 'running' && (app.portOpen ?? true)

  if (!url) {
    return <div className="embed-empty">이 앱에는 임베드할 대시보드가 없습니다.</div>
  }

  if (!live) {
    return (
      <div className="embed-empty">
        <div style={{ fontSize: 32 }}>◱</div>
        <div>
          대시보드는 앱이 <b>실행 중</b>일 때 여기 나타납니다.
          <br />
          <span className="faint mono">{url}</span>
        </div>
        {app.installState === 'installed' && (
          <button className="btn green" onClick={onStart}>
            ▶ {app.manifest.launchMode === 'process' ? '시작' : 'cmux에서 실행'}
          </button>
        )}
        {app.installState !== 'installed' && <span className="faint">먼저 앱을 설치하세요.</span>}
      </div>
    )
  }

  return (
    <div className="embed" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="embed-bar">
        <span>{url}</span>
        <span style={{ flex: 1 }} />
        <button
          className="btn ghost sm"
          onClick={() => {
            const w = ref.current as unknown as { reload?: () => void } | null
            w?.reload?.()
          }}
        >
          ↻ 새로고침
        </button>
        <button className="btn ghost sm" onClick={() => palace.openExternal(url)}>
          ↗ 브라우저
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <WebView ref={ref as never} src={url} style={{ width: '100%', height: '100%' }} allowpopups="true" />
      </div>
    </div>
  )
}
