export function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function formatDate(value?: string): string {
  if (!value) return '알 수 없음'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
