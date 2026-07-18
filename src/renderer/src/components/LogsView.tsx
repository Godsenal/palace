import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogLine } from '../../../shared/types'

export function LogsView({ logs }: { logs: LogLine[] }): JSX.Element {
  const [filter, setFilter] = useState<string>('all')
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const streams = useMemo(() => Array.from(new Set(logs.map((l) => l.stream))), [logs])
  const shown = filter === 'all' ? logs : logs.filter((l) => l.stream === filter)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [logs.length])

  return (
    <div className="logwrap">
      <div className="logbar">
        <span className="faint">스트림</span>
        <button className={`btn ghost sm ${filter === 'all' ? '' : ''}`} onClick={() => setFilter('all')} style={filter === 'all' ? { color: 'var(--text)' } : undefined}>
          전체
        </button>
        {streams.map((s) => (
          <button key={s} className="btn ghost sm" onClick={() => setFilter(s)} style={filter === s ? { color: 'var(--text)' } : undefined}>
            {s}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <span className="faint mono">{shown.length} lines</span>
      </div>
      <div className="logs">
        {shown.length === 0 ? (
          <div className="empty">아직 로그가 없습니다 — 설치·업데이트·시작하면 여기에 출력이 흐릅니다.</div>
        ) : (
          shown.map((l, i) => (
            <div key={i} className={`logline ${l.level === 'error' ? 'error' : ''}`}>
              <span className="tag">[{l.stream}]</span>
              {l.line}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
