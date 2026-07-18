import { useEffect, useState } from 'react'
import { palace } from '../api'
import type { AppView, EnvEntry, EnvView } from '../../../shared/types'

export function EnvEditor({ app, showToast }: { app: AppView; showToast: (m: string) => void }): JSX.Element {
  const id = app.manifest.id
  const [view, setView] = useState<EnvView | null>(null)
  const [entries, setEntries] = useState<EnvEntry[]>([])
  const [reveal, setReveal] = useState<Record<number, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = (): void => {
    setLoading(true)
    palace
      .readEnv(id)
      .then((v) => {
        setView(v)
        setEntries(v ? v.entries.map((e) => ({ ...e })) : [])
        setDirty(false)
      })
      .finally(() => setLoading(false))
  }
  useEffect(load, [id, app.installState])

  if (app.installState !== 'installed') {
    return <div className="pane"><div className="empty">앱을 설치하면 환경변수를 편집할 수 있어요.</div></div>
  }
  if (loading) return <div className="pane"><div className="empty"><span className="spin" /> 불러오는 중…</div></div>
  if (!view) return <div className="pane"><div className="empty">이 앱은 환경변수 편집을 지원하지 않습니다.</div></div>

  const update = (i: number, patch: Partial<EnvEntry>): void => {
    setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, ...patch } : e)))
    setDirty(true)
  }
  const remove = (i: number): void => {
    setEntries((prev) => prev.filter((_, idx) => idx !== i))
    setDirty(true)
  }
  const addRow = (): void => {
    setEntries((prev) => [...prev, { key: '', value: '', secret: false }])
    setDirty(true)
  }
  const save = async (): Promise<void> => {
    const clean = entries.filter((e) => e.key.trim())
    setSaving(true)
    try {
      const v = await palace.writeEnv(id, clean)
      setView(v)
      setEntries(v ? v.entries.map((e) => ({ ...e })) : clean)
      setDirty(false)
      showToast(`${view.path} 저장됨`)
    } catch (e) {
      showToast(`⚠ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }
  const seed = async (): Promise<void> => {
    const v = await palace.seedEnvFromExample(id)
    setView(v)
    setEntries(v ? v.entries.map((e) => ({ ...e })) : [])
    setDirty(false)
    showToast(`${app.manifest.env?.example} 에서 ${view.path} 생성`)
  }

  return (
    <div className="pane">
      <div className="card">
        <div className="row" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0, flex: 1 }}>
            환경변수 · <span className="mono" style={{ fontSize: 12 }}>{view.path}</span>
            {!view.exists && <span className="chip warn" style={{ marginLeft: 8, fontSize: 10 }}>아직 없음</span>}
          </h3>
          {!view.exists && view.hasExample && (
            <button className="btn sm" onClick={seed}>예시에서 생성</button>
          )}
          <button className="btn primary sm" onClick={save} disabled={!dirty || saving}>
            {saving ? <span className="spin" /> : '💾'} 저장
          </button>
        </div>

        {entries.length === 0 && <div className="faint" style={{ padding: '10px 0' }}>키가 없습니다. 아래 <b>＋ 키 추가</b>로 시작하세요.</div>}

        {entries.map((e, i) => (
          <div className="prereq" key={i} style={{ gap: 8 }}>
            <input
              className="mono"
              value={e.key}
              placeholder="KEY"
              onChange={(ev) => update(i, { key: ev.target.value, secret: /(TOKEN|KEY|SECRET|PASSWORD|VAPID|AUTH)/i.test(ev.target.value) })}
              style={envInput(180)}
            />
            <span className="faint">=</span>
            <input
              className="mono"
              type={e.secret && !reveal[i] ? 'password' : 'text'}
              value={e.value}
              placeholder="value"
              onChange={(ev) => update(i, { value: ev.target.value })}
              style={{ ...envInput(0), flex: 1 }}
            />
            {e.secret && (
              <button className="btn ghost sm" title="표시/숨김" onClick={() => setReveal((r) => ({ ...r, [i]: !r[i] }))}>
                {reveal[i] ? '🙈' : '👁'}
              </button>
            )}
            <button className="btn ghost sm" title="삭제" onClick={() => remove(i)}>✕</button>
          </div>
        ))}

        <button className="btn ghost sm" onClick={addRow} style={{ marginTop: 12 }}>＋ 키 추가</button>
      </div>
      <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
        비밀값(TOKEN·KEY·SECRET·PASSWORD·VAPID·AUTH)은 자동 마스킹됩니다. 저장 시 기존 파일의 주석·순서는 보존돼요.
        {app.manifest.env?.file?.includes('loops') && ' loops 는 여기 대신 대시보드 ⚙️ 에서 넣어도 됩니다(같은 파일).'}
      </div>
    </div>
  )
}

function envInput(width: number): React.CSSProperties {
  return {
    width: width || undefined,
    padding: '6px 9px',
    background: 'var(--bg)',
    border: '1px solid var(--line-2)',
    borderRadius: 7,
    color: 'var(--text)',
    fontSize: 12
  }
}
