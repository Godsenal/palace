import type { ReactNode } from 'react'

export type WorkbenchIconName = 'workspace' | 'loop' | 'automation' | 'runs' | 'skills' | 'sync' | 'remote' | 'machine' | 'setup' | 'tools' | 'plus' | 'terminal' | 'agent' | 'files' | 'send' | 'stop' | 'play' | 'refresh' | 'close' | 'chevron' | 'check' | 'warning' | 'search' | 'trash' | 'copy' | 'edit' | 'menu' | 'external' | 'branch' | 'heart' | 'download'

export function WorkbenchIcon({ name, size = 18 }: { name: WorkbenchIconName; size?: number }): JSX.Element {
  const paths: Record<WorkbenchIconName, ReactNode> = {
    workspace: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 4v16M8 9h13"/></>,
    loop: <><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></>,
    automation: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></>,
    runs: <><path d="m8 5 11 7-11 7Z"/><path d="M4 5v14"/></>,
    skills: <><path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.2 2.2-3-3Z"/></>,
    sync: <><path d="M20 7h-7a5 5 0 0 0-4.6 3"/><path d="m17 4 3 3-3 3M4 17h7a5 5 0 0 0 4.6-3"/><path d="m7 20-3-3 3-3"/></>,
    remote: <><rect x="5" y="2" width="14" height="20" rx="3"/><path d="M9 5h6M11 18h2"/></>,
    machine: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></>,
    setup: <><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/><circle cx="12" cy="12" r="3"/></>,
    tools: <><path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z"/><path d="m19.4 15 .1.1 1.2 2-2.2 2.2-2-1.2-.1-.1a8 8 0 0 1-2.4 1v2.4h-4V19a8 8 0 0 1-2.4-1l-.1.1-2 1.2-2.2-2.2 1.2-2 .1-.1a8 8 0 0 1-1-2.4H2.2v-3h2.4a8 8 0 0 1 1-2.4l-.1-.1-1.2-2 2.2-2.2 2 1.2.1.1a8 8 0 0 1 2.4-1V.8h4v2.4a8 8 0 0 1 2.4 1l.1-.1 2-1.2 2.2 2.2-1.2 2-.1.1a8 8 0 0 1 1 2.4h2.4v3h-2.4a8 8 0 0 1-1 2.4Z"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></>,
    agent: <><path d="M12 3a6 6 0 0 0-6 6v2a4 4 0 0 0-2 3.5A3.5 3.5 0 0 0 7.5 18H9"/><path d="M12 3a6 6 0 0 1 6 6v2a4 4 0 0 1 2 3.5 3.5 3.5 0 0 1-3.5 3.5H15M9 21h6"/><circle cx="9" cy="11" r="1"/><circle cx="15" cy="11" r="1"/></>,
    files: <><path d="M4 4h6l2 3h8v13H4Z"/><path d="M4 9h16"/></>,
    send: <><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
    play: <path d="m8 5 11 7-11 7Z"/>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.8-2L20 12M4 12l2.1 5a7 7 0 0 0 11.8-2"/></>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    warning: <><path d="M10.3 3.8 2.4 18a2 2 0 0 0 1.8 3h15.6a2 2 0 0 0 1.8-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    edit: <><path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/></>,
    menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v7H4V6h7"/></>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 13c6 0 8-2 8-4"/></>,
    heart: <><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></>
  }
  return <svg className="wb-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
