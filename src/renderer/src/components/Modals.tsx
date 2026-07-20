import { useState } from 'react'
import { palace } from '../api'
import type { AppView, LaunchMode, Manifest, Settings } from '../../../shared/types'

export function AddAppModal({
  onClose,
  onAdded
}: {
  onClose: () => void
  onAdded: (list: AppView[], id: string) => void
}): JSX.Element {
  const [repo, setRepo] = useState('')
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [tagline, setTagline] = useState('')
  const [runtime, setRuntime] = useState<'bun' | 'node' | 'other'>('node')
  const [launchMode, setLaunchMode] = useState<LaunchMode>('cmux')
  const [startCmd, setStartCmd] = useState('')
  const [installCmd, setInstallCmd] = useState('')
  const [dashUrl, setDashUrl] = useState('')
  const [dashPort, setDashPort] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const derivedId = id || guessId(repo)

  const submit = async (): Promise<void> => {
    setErr(null)
    if (!repo.trim()) return setErr('저장소 URL은 필수입니다')
    if (!derivedId) return setErr('id 를 추론할 수 없습니다 — 직접 입력하세요')
    const m: Manifest = {
      id: derivedId,
      name: name || derivedId,
      tagline: tagline || '',
      repo: repo.trim(),
      repoHttps: toHttps(repo.trim()),
      runtime,
      launchMode,
      start: startCmd.trim() ? { run: startCmd.trim() } : undefined,
      install: installCmd.trim() ? [{ run: installCmd.trim() }] : undefined,
      update: [{ run: 'git pull --ff-only' }],
      dashboard: dashUrl.trim()
        ? { url: dashUrl.trim(), port: dashPort ? Number(dashPort) : undefined }
        : undefined,
      readme: 'README.md',
      builtin: false
    }
    setSaving(true)
    try {
      const list = await palace.addManifest(m)
      onAdded(list, m.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>앱 추가</h2>
        <div className="sub">GitHub 저장소를 매니페스트로 등록하면 카탈로그에 나타납니다. (~/.palace/apps 에 저장)</div>

        <div className="field">
          <label>저장소 URL *</label>
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="git@github.com:Godsenal/my-tool.git" />
          <div className="hint">ssh 또는 https. id/이름을 비우면 여기서 추론합니다.</div>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>id</label>
            <input value={id} onChange={(e) => setId(e.target.value)} placeholder={derivedId || 'my-tool'} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>이름</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={derivedId} />
          </div>
        </div>
        <div className="field">
          <label>한 줄 소개</label>
          <input value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="이 도구가 뭘 하는지" />
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>런타임</label>
            <select value={runtime} onChange={(e) => setRuntime(e.target.value as 'bun' | 'node' | 'other')}>
              <option value="node">node</option>
              <option value="bun">bun</option>
              <option value="other">other</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>기동 방식</label>
            <select value={launchMode} onChange={(e) => setLaunchMode(e.target.value as LaunchMode)}>
              <option value="cmux">cmux (터미널에서 실행)</option>
              <option value="process">process (palace 가 직접)</option>
              <option value="manual">manual (수동)</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label>설치 명령 (clone 후 1회)</label>
          <input value={installCmd} onChange={(e) => setInstallCmd(e.target.value)} placeholder="bun install  또는  ./install.sh" />
        </div>
        <div className="field">
          <label>시작 명령</label>
          <input value={startCmd} onChange={(e) => setStartCmd(e.target.value)} placeholder="bun start  또는  loopctl dashboard" />
        </div>
        <div className="row" style={{ gap: 12 }}>
          <div className="field" style={{ flex: 2 }}>
            <label>대시보드 URL</label>
            <input value={dashUrl} onChange={(e) => setDashUrl(e.target.value)} placeholder="http://localhost:3000" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>포트</label>
            <input value={dashPort} onChange={(e) => setDashPort(e.target.value)} placeholder="3000" />
          </div>
        </div>

        {err && <div className="notes" style={{ borderColor: 'rgba(248,113,113,0.3)' }}><span>⚠</span><span>{err}</span></div>}
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>취소</button>
          <button className="btn primary" onClick={submit} disabled={saving}>
            {saving ? <span className="spin" /> : '＋'} 추가
          </button>
        </div>
      </div>
    </div>
  )
}

export function SettingsModal({
  settings,
  onClose,
  onSaved
}: {
  settings: Settings
  onClose: () => void
  onSaved: (s: Settings) => void
}): JSX.Element {
  const [installRoot, setInstallRoot] = useState(settings.installRoot)
  const [shell, setShell] = useState(settings.shell ?? '')
  const [launchAtLogin, setLaunchAtLogin] = useState(settings.launchAtLogin !== false)
  const [autoWireTools, setAutoWireTools] = useState(settings.autoWireTools !== false)
  const [saving, setSaving] = useState(false)
  const [hub, setHub] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const s = await palace.setSettings({
        installRoot: installRoot.trim(),
        shell: shell.trim() || undefined,
        launchAtLogin,
        autoWireTools
      })
      onSaved(s)
    } finally {
      setSaving(false)
    }
  }

  const checkHub = async (): Promise<void> => {
    setHub('확인 중…')
    const r = await palace.checkForHubUpdate()
    if (r.error) setHub(`확인 실패 (패키징 후 GitHub Releases 필요): ${r.error}`)
    else setHub(r.available ? `새 버전 ${r.version} 있음` : '최신 버전입니다')
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>설정</h2>
        <div className="sub">palace 전역 설정 (~/.palace/settings.json)</div>
        <div className="field">
          <label>새 앱 설치 루트</label>
          <input value={installRoot} onChange={(e) => setInstallRoot(e.target.value)} placeholder="~/LTH" />
          <div className="hint">새 앱을 clone 할 기본 위치. 이미 이 아래 clone 돼 있으면 재clone 없이 감지합니다.</div>
        </div>
        <div className="field">
          <label>로그인 셸 (선택)</label>
          <input value={shell} onChange={(e) => setShell(e.target.value)} placeholder="/bin/zsh (비우면 자동감지)" />
          <div className="hint">명령 실행 시 PATH(bun·loopctl·brew) 확보용. 보통 비워두면 됩니다.</div>
        </div>
        <div className="field">
          <label>부팅 자동 실행</label>
          <label className="row" style={{ cursor: 'pointer', gap: 8 }}>
            <input type="checkbox" checked={launchAtLogin} onChange={(e) => setLaunchAtLogin(e.target.checked)} />
            <span>로그인 시 palace + cmux 자동 실행 (로그인 항목 등록)</span>
          </label>
          <div className="hint">끄면 palace 가 로그인 항목을 건드리지 않습니다.</div>
        </div>
        <div className="field">
          <label>도구 자동시작 배선</label>
          <label className="row" style={{ cursor: 'pointer', gap: 8 }}>
            <input type="checkbox" checked={autoWireTools} onChange={(e) => setAutoWireTools(e.target.checked)} />
            <span>palace 실행 시 설치된 도구의 자동시작 자동 배선</span>
          </label>
          <div className="hint">
            cmux-remote(~/.zshrc 훅)·loops(launchd supervisor)를 멱등 배선. 이미 다 깔린 컴퓨터도 palace 만 켜면 걸립니다.
          </div>
        </div>
        <div className="field">
          <label>허브 자체 업데이트</label>
          <div className="row">
            <button className="btn sm" onClick={checkHub}>업데이트 확인</button>
            {hub && <span className="faint" style={{ fontSize: 12 }}>{hub}</span>}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>닫기</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : ''} 저장</button>
        </div>
      </div>
    </div>
  )
}

function guessId(repo: string): string {
  const m = repo.match(/([^/:]+?)(\.git)?$/)
  return m ? m[1] : ''
}
function toHttps(repo: string): string {
  const m = repo.match(/^git@([^:]+):(.+?)(\.git)?$/)
  if (m) return `https://${m[1]}/${m[2]}`
  return repo.replace(/\.git$/, '')
}
