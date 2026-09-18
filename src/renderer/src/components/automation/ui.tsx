import { useEffect, useId, useRef, type ReactNode } from 'react'

export type IconName =
  | 'automation'
  | 'runs'
  | 'sync'
  | 'machine'
  | 'tools'
  | 'plus'
  | 'play'
  | 'pause'
  | 'edit'
  | 'trash'
  | 'check'
  | 'refresh'
  | 'copy'
  | 'eye'
  | 'eyeOff'
  | 'close'
  | 'chevron'
  | 'warning'
  | 'webhook'
  | 'save'
  | 'download'
  | 'upload'
  | 'stop'

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): JSX.Element {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  const paths: Record<IconName, ReactNode> = {
    automation: <><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="4"/><path d="m5.6 5.6 2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></>,
    runs: <><path d="M8 5v14l11-7Z"/><path d="M4 5v14"/></>,
    sync: <><path d="M20 7h-7a5 5 0 0 0-4.6 3"/><path d="m17 4 3 3-3 3"/><path d="M4 17h7a5 5 0 0 0 4.6-3"/><path d="m7 20-3-3 3-3"/></>,
    machine: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
    tools: <><path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.2 2.2-3-3Z"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    play: <path d="m8 5 11 7-11 7Z"/>,
    pause: <><path d="M9 5v14M15 5v14"/></>,
    edit: <><path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    refresh: <><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.8-2L20 12M4 12l2.1 5a7 7 0 0 0 11.8-2"/></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>,
    eyeOff: <><path d="m3 3 18 18"/><path d="M10.6 6.2A11 11 0 0 1 12 6c6.5 0 10 6 10 6a15 15 0 0 1-2.1 2.8M6.6 6.6C3.6 8.4 2 12 2 12s3.5 6 10 6a10 10 0 0 0 4.1-.8"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    warning: <><path d="M10.3 3.8 2.4 18a2 2 0 0 0 1.8 3h15.6a2 2 0 0 0 1.8-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></>,
    webhook: <><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><circle cx="12" cy="6" r="3"/><path d="m8.6 8.5-2 5.5M15.4 8.5l2 5.5M9 17h6"/></>,
    save: <><path d="M5 3h12l2 2v16H5Z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/></>,
    upload: <><path d="M12 21V9M7 14l5-5 5 5"/><path d="M5 3h14"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1"/>
  }
  return <svg {...common}>{paths[name]}</svg>
}

export function Modal({
  title,
  description,
  children,
  onClose,
  footer,
  width = 'medium'
}: {
  title: string
  description?: string
  children: ReactNode
  onClose: () => void
  footer?: ReactNode
  width?: 'small' | 'medium' | 'large'
}): JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  const titleId = useId()
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first = panel.current?.querySelector<HTMLElement>('[autofocus]') ?? panel.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
    first?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close.current()
      if (event.key !== 'Tab' || !panel.current) return
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'))
      if (!focusable.length) return
      const firstItem = focusable[0]
      const lastItem = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      previous?.focus()
    }
  }, [])

  return (
    <div className="auto-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={panel} className={`auto-modal auto-modal--${width}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="auto-modal__head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="auto-icon-button" type="button" onClick={onClose} aria-label="닫기"><Icon name="close" /></button>
        </div>
        <div className="auto-modal__body">{children}</div>
        {footer && <div className="auto-modal__footer">{footer}</div>}
      </div>
    </div>
  )
}

export function InlineError({ children }: { children: ReactNode }): JSX.Element {
  return <div className="auto-inline-message auto-inline-message--error" role="alert"><Icon name="warning" /> <span>{children}</span></div>
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }): JSX.Element {
  return <div className="auto-empty"><div className="auto-empty__mark"><Icon name="automation" size={22} /></div><strong>{title}</strong><p>{description}</p>{action}</div>
}

export function BusyLabel({ label }: { label: string }): JSX.Element {
  return <><span className="spin" aria-hidden="true" /> {label}</>
}

export function statusTone(status: string): 'good' | 'warn' | 'bad' | 'neutral' | 'live' {
  if (status === 'succeeded') return 'good'
  if (status === 'running' || status === 'checking') return 'live'
  if (status === 'queued' || status === 'needs-review') return 'warn'
  if (status === 'failed' || status === 'interrupted') return 'bad'
  return 'neutral'
}

export const runStatusLabel: Record<string, string> = {
  queued: '대기 중', running: '실행 중', checking: '검사 중', succeeded: '성공', 'needs-review': '검토 필요', failed: '실패', cancelled: '취소됨', interrupted: '중단됨'
}

export function formatTime(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}
