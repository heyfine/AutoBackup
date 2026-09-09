import { render } from 'preact'
import { useState, useEffect, useRef } from 'preact/hooks'
import './style.css'

// ---- types（与后端对齐） ----
interface RunPublic {
  id: string
  profileId: string
  trigger: string
  status: string
  stage: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  sizeBytes?: number
  encrypted: boolean
  pushes: { targetId: string; status: string; attempts: number; error?: string }[]
  error?: string
}
interface ScheduleSpec {
  mode: 'daily' | 'interval'
  at?: string
  hours?: number
}
interface Profile {
  id: string
  name: string
  kind: string
  paths: string[]
  encrypt: boolean
  enabled: boolean
  isDraft: boolean
  schedule: ScheduleSpec
  targetIds: string[]
  keep: number
  lastRunAt?: string
  recentRuns: RunPublic[]
}
interface Target {
  id: string
  name: string
  url: string
  username: string
  enabled: boolean
  keep: number
  hasPassword: boolean
  capacityQuotaMb?: number
  timeoutMin: number
  allowUnencrypted: boolean
}

// ---- API helpers ----
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(opts?.headers as Record<string, string>) }
  // 只在有 body 时声明 JSON（无 body 的 POST 会被 Fastify 400 拒绝）
  if (opts?.body) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { ...opts, headers })
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.location.hash = '#/login'
    throw new Error('unauthorized')
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error)
  return res.json() as Promise<T>
}

function fmtSize(n?: number): string {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
function fmtTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} 小时前`
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function scheduleLabel(s: ScheduleSpec): string {
  if (s.mode === 'daily') return `每天 ${s.at}`
  return `每 ${s.hours} 小时`
}

// ---- App ----
export function App() {
  const [route, setRoute] = useState(window.location.hash || '#/dashboard')
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '#/dashboard')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  if (route === '#/login') return <Login />
  return <Shell route={route} />
}

// ---- Login ----
function Login() {
  const [pwd, setPwd] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ password: pwd }) })
      window.location.hash = '#/dashboard'
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="login-wrap">
      <form class="login-card" onSubmit={submit}>
        <h1>🔐 AutoBackup</h1>
        <p class="muted">备份中心 · 单管理员</p>
        <input type="password" placeholder="管理员密码" value={pwd} onInput={(e) => setPwd((e.target as HTMLInputElement).value)} autofocus />
        {err && <div class="err">{err}</div>}
        <button type="submit" disabled={busy}>{busy ? '…' : '登录'}</button>
      </form>
    </div>
  )
}

// ---- Shell ----
function Shell({ route }: { route: string }) {
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {})
    window.location.hash = '#/login'
  }
  return (
    <div class="shell">
      <header>
        <span class="logo">🔐 AutoBackup</span>
        <nav>
          <a href="#/dashboard" class={route.startsWith('#/dashboard') ? 'on' : ''}>仪表盘</a>
          <a href="#/profiles" class={route.startsWith('#/profiles') ? 'on' : ''}>备份档案</a>
          <a href="#/targets" class={route.startsWith('#/targets') ? 'on' : ''}>WebDAV 目标</a>
          <a href="#/settings" class={route.startsWith('#/settings') ? 'on' : ''}>设置</a>
        </nav>
        <button class="ghost" onClick={logout}>退出</button>
      </header>
      <main>
        {route.startsWith('#/dashboard') && <Dashboard />}
        {route.startsWith('#/profiles') && <Profiles />}
        {route.startsWith('#/targets') && <Targets />}
        {route.startsWith('#/settings') && <Settings />}
      </main>
    </div>
  )
}

// ---- Dashboard ----
function Dashboard() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [running, setRunning] = useState<string | null>(null)
  const [err, setErr] = useState('')

  const load = () => api<{ profiles: Profile[] }>('/api/profiles').then((r) => setProfiles(r.profiles)).catch(() => {})
  useEffect(() => {
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])

  const runNow = async (id: string) => {
    setRunning(id)
    setErr('')
    try {
      await api(`/api/profiles/${id}/run`, { method: 'POST' })
      await load()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setRunning(null)
    }
  }

  const failed = profiles.filter((p) => p.recentRuns[0] && p.recentRuns[0].status !== 'success')
  const lastAny = profiles
    .flatMap((p) => (p.recentRuns[0] ? [p.recentRuns[0].startedAt] : []))
    .sort()
    .pop()

  return (
    <div>
      <div class={`statusbar ${failed.length === 0 ? 'ok' : 'bad'}`}>
        {failed.length === 0
          ? `✅ 全部正常 · 最近备份 ${fmtTime(lastAny)}`
          : `❌ ${failed.length} 项异常：${failed.map((p) => p.name).join('、')}`}
      </div>
      {err && <div class="banner-err">{err}</div>}
      <div class="cards">
        {profiles.map((p) => {
          const last = p.recentRuns[0]
          const status = last?.status ?? 'never'
          const cls = status === 'success' ? 'ok' : status === 'failed' ? 'bad' : 'idle'
          return (
            <div class={`card ${cls}`} key={p.id}>
              <div class="card-head">
                <span class="name">{p.name}</span>
                {p.encrypt && <span class="badge">🔒</span>}
                {p.isDraft && <span class="badge warn">草稿</span>}
                {!p.enabled && <span class="badge warn">停用</span>}
              </div>
              <div class="card-meta">
                <span>{p.kind}</span> · <span>{scheduleLabel(p.schedule)}</span> · 保留 {p.keep} 份
              </div>
              <div class="card-last">
                {last ? (
                  <>
                    <span class={`dot ${cls}`} /> {status} · {fmtTime(last.startedAt)} · {fmtSize(last.sizeBytes)}
                  </>
                ) : (
                  <span class="muted">从未备份（下次：{scheduleLabel(p.schedule)}）</span>
                )}
              </div>
              {last?.error && <div class="card-err">{last.error}</div>}
              <button class="ghost sm" disabled={running === p.id} onClick={() => runNow(p.id)}>
                {running === p.id ? '备份中…' : '立即备份'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---- Profiles（档案管理：列表 + 编辑器） ----
function Profiles() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [targets, setTargets] = useState<Target[]>([])
  const [editing, setEditing] = useState<Profile | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [msg, setMsg] = useState('')
  const [drafts, setDrafts] = useState<import('./types').DetectedDraft[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanInfo, setScanInfo] = useState('')
  const [restoring, setRestoring] = useState<Profile | null>(null)

  const load = async () => {
    const [pr, tg] = await Promise.all([
      api<{ profiles: Profile[] }>('/api/profiles'),
      api<{ targets: Target[] }>('/api/targets'),
    ])
    setProfiles(pr.profiles)
    setTargets(tg.targets)
  }
  useEffect(() => {
    load()
  }, [])

  /** 扫描新应用（docker 检测） */
  const scan = async () => {
    setScanning(true)
    setScanInfo('')
    try {
      const r = await api<{ drafts: import('./types').DetectedDraft[]; scanned: number; error?: string }>('/api/detect', { method: 'POST' })
      if (r.error) {
        setScanInfo(`⚠️ ${r.error}`)
        setDrafts([])
      } else {
        setDrafts(r.drafts)
        setScanInfo(`扫描了 ${r.scanned} 个容器，发现 ${r.drafts.length} 个新应用`)
      }
    } catch (ex) {
      setScanInfo(`❌ ${ex instanceof Error ? ex.message : String(ex)}`)
    } finally {
      setScanning(false)
    }
  }

  /** 采纳草稿：建档案（默认停用），跳到编辑器让用户确认细节 */
  const adopt = async (d: import('./types').DetectedDraft) => {
    try {
      const r = await api<{ profile: Profile }>('/api/profiles/adopt', {
        method: 'POST',
        body: JSON.stringify({ draft: d }),
      })
      setDrafts((s) => s.filter((x) => x.containerName !== d.containerName))
      setMsg(`✅ 已添加「${r.profile.name}」（默认停用，请编辑确认后打开开关）`)
      await load()
      // 直接进入编辑器
      setIsNew(true)
      setEditing({ ...r.profile, recentRuns: [] })
    } catch (ex) {
      setMsg(`❌ ${ex instanceof Error ? ex.message : String(ex)}`)
    }
  }

  /** iOS 风格启停开关 */
  const toggle = async (p: Profile) => {
    // 乐观更新
    setProfiles((s) => s.map((x) => (x.id === p.id ? { ...x, enabled: !x.enabled } : x)))
    try {
      await api(`/api/profiles/${p.id}/toggle`, { method: 'POST' })
    } catch {
      await load() // 失败回滚
    }
  }

  const startEdit = (p: Profile | null) => {
    setIsNew(!p)
    setEditing(
      p
        ? { ...p }
        : {
            id: '',
            name: '',
            kind: 'directory',
            paths: [],
            containers: [],
            encrypt: false,
            enabled: false, // 新建默认停用（用户确认后自己开）
            isDraft: false,
            schedule: { mode: 'daily', at: '03:00' },
            targetIds: [],
            keep: 7,
            recentRuns: [],
          },
    )
  }

  const save = async () => {
    if (!editing) return
    setMsg('')
    try {
      const body: Record<string, unknown> = { ...editing }
      if (isNew) delete (body as { recentRuns?: unknown }).recentRuns
      await api('/api/profiles', { method: 'POST', body: JSON.stringify(body) })
      setMsg('✅ 已保存')
      setEditing(null)
      await load()
    } catch (ex) {
      setMsg(`❌ ${ex instanceof Error ? ex.message : String(ex)}`)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('确认删除该档案？（远端备份文件不受影响）')) return
    await api(`/api/profiles/${id}`, { method: 'DELETE' })
    await load()
  }

  if (editing) {
    const p = editing
    const upd = (patch: Partial<Profile>) => setEditing({ ...p, ...patch })
    return (
      <div class="card wide editor">
        <div class="card-head">
          <span class="name">{isNew ? '新建备份档案' : `编辑：${p.name}`}</span>
        </div>
        {msg && <div class="banner-ok">{msg}</div>}
        <div class="form-grid">
          <label>名称 <input value={p.name} onInput={(e) => upd({ name: (e.target as HTMLInputElement).value })} /></label>
          <label>
            类型
            <select value={p.kind} onChange={(e) => upd({ kind: (e.target as HTMLSelectElement).value })}>
              <option value="directory">目录</option>
              <option value="config">配置目录</option>
              <option value="sqlite">SQLite 数据库</option>
              <option value="mariadb">MariaDB / MySQL</option>
              <option value="postgres">PostgreSQL</option>
            </select>
          </label>
        </div>
        {(p.kind === 'directory' || p.kind === 'config') && (
          <label class="full">
            目录路径（每行一个）
            <textarea rows={3} value={p.paths.join('\n')} onInput={(e) => upd({ paths: (e.target as HTMLTextAreaElement).value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
          </label>
        )}
        {p.kind === 'sqlite' && (
          <label class="full">数据库文件路径 <input value={p.dbPath ?? ''} onInput={(e) => upd({ dbPath: (e.target as HTMLInputElement).value })} placeholder="/opt/xxx/data/db.sqlite3" /></label>
        )}
        {(p.kind === 'mariadb' || p.kind === 'postgres') && (
          <div class="form-grid">
            <label>容器名 <input value={p.containers[0] ?? ''} onInput={(e) => upd({ containers: [(e.target as HTMLInputElement).value] })} /></label>
            <label>数据库名 <input value={p.database ?? ''} onInput={(e) => upd({ database: (e.target as HTMLInputElement).value })} /></label>
            {p.kind === 'postgres' && (
              <label>连接用户 <input value={p.dbUser ?? ''} onInput={(e) => upd({ dbUser: (e.target as HTMLInputElement).value })} placeholder="默认 postgres" /></label>
            )}
            {p.kind === 'mariadb' && (
              <label>dump 命令 <input value={p.dumpTool ?? ''} onInput={(e) => upd({ dumpTool: (e.target as HTMLInputElement).value })} placeholder="默认 mariadb-dump（自动 fallback mysqldump）" /></label>
            )}
          </div>
        )}
        <div class="form-grid">
          <label>
            备份频率
            <select
              value={p.schedule.mode}
              onChange={(e) => {
                const mode = (e.target as HTMLSelectElement).value as 'daily' | 'interval'
                upd({ schedule: mode === 'daily' ? { mode, at: p.schedule.at ?? '03:00' } : { mode, hours: p.schedule.hours ?? 12 } })
              }}
            >
              <option value="daily">每天固定时刻</option>
              <option value="interval">每隔 N 小时</option>
            </select>
          </label>
          {p.schedule.mode === 'daily' ? (
            <label>时刻 <input type="time" value={p.schedule.at ?? '03:00'} onInput={(e) => upd({ schedule: { mode: 'daily', at: (e.target as HTMLInputElement).value } })} /></label>
          ) : (
            <label>间隔（小时） <input type="number" min={1} max={168} value={p.schedule.hours ?? 12} onInput={(e) => upd({ schedule: { mode: 'interval', hours: Number((e.target as HTMLInputElement).value) } })} /></label>
          )}
          <label>保留份数 <input type="number" min={3} max={365} value={p.keep} onInput={(e) => upd({ keep: Number((e.target as HTMLInputElement).value) })} /></label>
        </div>
        <div class="form-grid">
          <div class="full">
            <div class="muted" style="margin-bottom:6px">推送到哪些 WebDAV 目标（不选 = 全部启用目标）</div>
            <div class="check-row">
              {targets.length === 0 && <span class="muted">尚无目标，请先到「WebDAV 目标」添加</span>}
              {targets.map((t) => (
                <label class="check-item" key={t.id}>
                  <input
                    type="checkbox"
                    checked={p.targetIds.includes(t.id)}
                    onChange={(e) => {
                      const checked = (e.target as HTMLInputElement).checked
                      upd({ targetIds: checked ? [...p.targetIds, t.id] : p.targetIds.filter((x) => x !== t.id) })
                    }}
                  />
                  {t.name}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div class="check-row">
          <label class="check-item">
            <Toggle checked={p.encrypt} onChange={(v) => upd({ encrypt: v })} /> age 加密（敏感数据建议开）
          </label>
          <label class="check-item">
            <Toggle checked={p.enabled} onChange={(v) => upd({ enabled: v })} /> 启用备份
          </label>
        </div>
        <div class="btn-row">
          <button onClick={save}>保存</button>
          <button class="ghost" onClick={() => setEditing(null)}>取消</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      {msg && <div class="banner-ok">{msg}</div>}
      <div class="toolbar">
        <button onClick={() => startEdit(null)}>＋ 新建档案</button>
        <button class="ghost" disabled={scanning} onClick={scan}>{scanning ? '扫描中…' : '🔍 扫描新应用'}</button>
        {scanInfo && <span class="muted" style="margin-left:10px">{scanInfo}</span>}
      </div>

      {drafts.length > 0 && (
        <div class="card wide detect-banner">
          <div class="card-head"><span class="name">🆕 检测到 {drafts.length} 个新应用</span></div>
          <p class="muted">已按指纹生成建议配置。采纳后默认<strong>停用</strong>——请编辑确认细节（库名/路径/频率）后再打开开关。</p>
          {drafts.map((d) => (
            <div class="detect-item" key={d.containerName}>
              <div>
                <strong>{d.suggestedProfile?.name ?? d.containerName}</strong>
                <span class="muted"> · 容器 {d.containerName} · {d.image}</span>
              </div>
              <button class="ghost sm" onClick={() => adopt(d)}>采纳为档案</button>
            </div>
          ))}
        </div>
      )}

      <div class="cards">
        {profiles.map((p) => {
          const last = p.recentRuns[0]
          const cls = last?.status === 'success' ? 'ok' : last?.status === 'failed' ? 'bad' : 'idle'
          return (
            <div class={`card ${p.enabled ? '' : 'card-off'}`} key={p.id}>
              <div class="card-head">
                <span class="name">{p.name}</span>
                {p.encrypt && <span class="badge">🔒</span>}
                <span style="margin-left:auto">
                  <Toggle checked={p.enabled} onChange={() => toggle(p)} />
                </span>
              </div>
              <div class="card-meta">{p.kind} · {scheduleLabel(p.schedule)} · 保留 {p.keep} 份 · 目标 {p.targetIds.length === 0 ? '全部' : p.targetIds.length}</div>
              <div class="card-last">
                {last ? <><span class={`dot ${cls}`} /> {fmtTime(last.startedAt)} · {fmtSize(last.sizeBytes)}</> : <span class="muted">从未备份</span>}
              </div>
              {last?.error && <div class="card-err">{last.error}</div>}
              <div class="btn-row">
                <button class="ghost sm" onClick={() => startEdit(p)}>编辑</button>
                <button class="ghost sm" onClick={() => setRestoring(p)}>还原</button>
                <button class="ghost sm danger" onClick={() => remove(p.id)}>删除</button>
              </div>
            </div>
          )
        })}
      </div>
      {restoring && <RestoreDialog profile={restoring} onClose={() => { setRestoring(null); load() }} />}
    </div>
  )
}

/** iOS 风格滑动开关 */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <span
      class={`ios-toggle ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span class="knob" />
    </span>
  )
}

// ---- Restore（还原流程：选快照 → 预览 or RED 确认覆盖） ----
interface ArtifactInfo {
  runId: string
  artifactPath: string
  sizeBytes?: number
  encrypted: boolean
  startedAt: string
  exists: boolean
}

function RestoreDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([])
  const [selected, setSelected] = useState<ArtifactInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ steps: string[]; previewDir?: string; preRestoreBackup?: string; mode: string } | null>(null)
  const [err, setErr] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [showInplace, setShowInplace] = useState(false)

  useEffect(() => {
    api<{ artifacts: ArtifactInfo[] }>(`/api/profiles/${profile.id}/artifacts`)
      .then((r) => {
        setArtifacts(r.artifacts)
        setSelected(r.artifacts[0] ?? null)
      })
      .catch((ex) => setErr(ex instanceof Error ? ex.message : String(ex)))
  }, [profile.id])

  const doRestore = async (mode: 'preview' | 'inplace') => {
    if (!selected) return
    setBusy(true)
    setErr('')
    try {
      const r = await api<{ steps: string[]; previewDir?: string; preRestoreBackup?: string; mode: string }>(
        `/api/profiles/${profile.id}/restore`,
        { method: 'POST', body: JSON.stringify({ runId: selected.runId, mode, confirmName: mode === 'inplace' ? confirmText : undefined }) },
      )
      setResult(r)
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="modal-mask" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="card wide editor modal">
        <div class="card-head">
          <span class="name">还原：{profile.name}</span>
          <button class="ghost sm" onClick={onClose}>✕</button>
        </div>

        {result ? (
          <div>
            <div class={`statusbar ${result.mode === 'preview' ? 'ok' : 'ok'}`}>
              {result.mode === 'preview' ? '✅ 预览解包完成（生产数据未动）' : '✅ 正式还原完成'}
            </div>
            <ol class="steps">
              {result.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            {result.preRestoreBackup && (
              <div class="banner-ok">还原前数据已兜底：{result.preRestoreBackup}（如需回退可手动拷回）</div>
            )}
            <div class="btn-row">
              <button onClick={onClose}>关闭</button>
            </div>
          </div>
        ) : (
          <div>
            <p class="muted">选择要还原的本地快照（仅显示本地 artifact 还存在的）：</p>
            {artifacts.length === 0 && <div class="muted">没有可用的本地快照。远端 WebDAV 上的备份请下载后放入 artifacts/ 目录。</div>}
            <div class="snapshot-list">
              {artifacts.map((a) => (
                <div class={`snapshot-item ${!a.exists ? 'muted' : ''}`} key={a.runId}>
                  <label style="display:flex;gap:10px;align-items:center;flex:1;cursor:pointer">
                    <input type="radio" name="snap" checked={selected?.runId === a.runId} disabled={!a.exists} onChange={() => setSelected(a)} />
                    <span>{fmtTime(a.startedAt)}</span>
                    <span class="muted">{fmtSize(a.sizeBytes)}{a.encrypted ? ' 🔒' : ''}{!a.exists ? ' · 文件缺失' : ''}</span>
                  </label>
                  {a.exists && (
                    <span class="dl-links">
                      <a href={`/api/artifacts/download?runId=${encodeURIComponent(a.runId)}`} class="ghost sm dl-btn" title="下载备份包">⬇ 包</a>
                      <a href={`/api/artifacts/download?path=${encodeURIComponent(a.artifactPath.replace(/\.tar\.gz(\.age)?$/, '.manifest.json'))}`} class="ghost sm dl-btn" title="下载清单">清单</a>
                    </span>
                  )}
                </div>
              ))}
            </div>

            {err && <div class="banner-err">{err}</div>}

            {!showInplace ? (
              <div class="btn-row">
                <button disabled={!selected || busy} onClick={() => doRestore('preview')}>{busy ? '解包中…' : '📦 预览解包（不动生产数据）'}</button>
                <button class="danger-solid" disabled={!selected || busy} onClick={() => setShowInplace(true)}>⚠️ 正式还原（覆盖）</button>
              </div>
            ) : (
              <div class="red-zone">
                <div class="red-title">RED 级操作：正式还原将覆盖当前数据</div>
                <p>将覆盖档案「<strong>{profile.name}</strong>」的现有数据（还原前会自动做兜底备份）。</p>
                <p>请输入档案名 <strong>{profile.name}</strong> 确认：</p>
                <input value={confirmText} onInput={(e) => setConfirmText((e.target as HTMLInputElement).value)} placeholder={profile.name} />
                <div class="btn-row">
                  <button class="danger-solid" disabled={confirmText !== profile.name || busy} onClick={() => doRestore('inplace')}>
                    {busy ? '还原中…' : '我已知晓风险，执行还原'}
                  </button>
                  <button class="ghost" onClick={() => setShowInplace(false)}>返回</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---- Targets（多供应商管理） ----
function Targets() {
  const [targets, setTargets] = useState<Target[]>([])
  const [editing, setEditing] = useState<Partial<Target> & { password?: string } | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState('')

  const load = () => api<{ targets: Target[] }>('/api/targets').then((r) => setTargets(r.targets))
  useEffect(() => {
    load()
  }, [])

  /** iOS 风格启停开关（乐观更新，失败回滚） */
  const toggle = async (t: Target) => {
    setTargets((s) => s.map((x) => (x.id === t.id ? { ...x, enabled: !x.enabled } : x)))
    try {
      await api(`/api/targets/${t.id}/toggle`, { method: 'POST' })
    } catch {
      await load()
    }
  }

  const save = async () => {
    if (!editing) return
    setMsg('')
    try {
      await api('/api/targets', { method: 'POST', body: JSON.stringify(editing) })
      setMsg('✅ 已保存')
      setEditing(null)
      await load()
    } catch (ex) {
      setMsg(`❌ ${ex instanceof Error ? ex.message : String(ex)}`)
    }
  }

  const test = async (t: Partial<Target> & { password?: string }) => {
    setTesting('form')
    try {
      const r = await api<{ ok: boolean; message: string }>('/api/targets/test', {
        method: 'POST',
        body: JSON.stringify({ url: t.url, username: t.username, password: t.password, targetId: t.id }),
      })
      setTestResult((s) => ({ ...s, [t.id ?? 'form']: `${r.ok ? '✅' : '❌'} ${r.message}` }))
    } catch (ex) {
      setTestResult((s) => ({ ...s, [t.id ?? 'form']: `❌ ${ex instanceof Error ? ex.message : String(ex)}` }))
    } finally {
      setTesting(null)
    }
  }

  const testSaved = async (id: string) => {
    setTesting(id)
    try {
      const r = await api<{ ok: boolean; message: string }>('/api/targets/test', {
        method: 'POST',
        body: JSON.stringify({ targetId: id }),
      })
      setTestResult((s) => ({ ...s, [id]: `${r.ok ? '✅' : '❌'} ${r.message}` }))
    } catch (ex) {
      setTestResult((s) => ({ ...s, [id]: `❌ ${ex instanceof Error ? ex.message : String(ex)}` }))
    } finally {
      setTesting(null)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('确认删除该 WebDAV 目标？绑定它的档案将不再推送。')) return
    await api(`/api/targets/${id}`, { method: 'DELETE' })
    await load()
  }

  if (editing) {
    const t = editing
    const upd = (patch: Partial<Target> & { password?: string }) => setEditing({ ...t, ...patch })
    return (
      <div class="card wide editor">
        <div class="card-head">
          <span class="name">{t.id ? `编辑：${t.name}` : '添加 WebDAV 目标'}</span>
        </div>
        <p class="muted">支持任意标准 WebDAV 供应商：Koofr、坚果云、InfiniCloud、群晖、Alist、Nextcloud…</p>
        <div class="form-grid">
          <label>名称 <input value={t.name ?? ''} onInput={(e) => upd({ name: (e.target as HTMLInputElement).value })} placeholder="如 Koofr 主力 / 群晖家用" /></label>
          <label class="full">
            WebDAV 地址 <input value={t.url ?? ''} onInput={(e) => upd({ url: (e.target as HTMLInputElement).value })} placeholder="https://app.koofr.net/dav/Koofr/autobackup" />
          </label>
          <label>用户名 <input value={t.username ?? ''} onInput={(e) => upd({ username: (e.target as HTMLInputElement).value })} /></label>
          <label>密码 <input type="password" value={t.password ?? ''} onInput={(e) => upd({ password: (e.target as HTMLInputElement).value })} placeholder={t.hasPassword ? '••••••（留空保持不变）' : '应用专用密码'} /></label>
          <label>保留份数（默认） <input type="number" min={3} max={365} value={t.keep ?? 7} onInput={(e) => upd({ keep: Number((e.target as HTMLInputElement).value) })} /></label>
          <label>容量配额 GB（可选，触发自动裁剪） <input type="number" min={0} value={t.capacityQuotaMb ? (t.capacityQuotaMb / 1024).toFixed(0) : ''} onInput={(e) => upd({ capacityQuotaMb: Number((e.target as HTMLInputElement).value) * 1024 || undefined })} placeholder="如 10" /></label>
          <label>上传超时（分钟） <input type="number" min={5} max={240} value={t.timeoutMin ?? 30} onInput={(e) => upd({ timeoutMin: Number((e.target as HTMLInputElement).value) })} /></label>
        </div>
        <label class="check-item">
          <Toggle checked={t.allowUnencrypted ?? true} onChange={(v) => upd({ allowUnencrypted: v })} /> 允许未加密备份（关闭则只收加密包，强烈建议敏感服务器关闭）
        </label>
        {t.id && (
          <label class="check-item">
            <Toggle checked={t.enabled ?? true} onChange={(v) => upd({ enabled: v })} /> 启用此目标（关闭后档案推送会跳过它）
          </label>
        )}
        {testResult[t.id ?? 'form'] && <div class="banner-ok">{testResult[t.id ?? 'form']}</div>}
        <div class="btn-row">
          <button class="ghost" disabled={testing === 'form'} onClick={() => test(t)}>测试连接</button>
          <button onClick={save}>保存</button>
          <button class="ghost" onClick={() => setEditing(null)}>取消</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      {msg && <div class="banner-ok">{msg}</div>}
      <div class="toolbar">
        <button onClick={() => setEditing({ enabled: true, keep: 7, timeoutMin: 30, allowUnencrypted: true })}>＋ 添加 WebDAV 目标</button>
      </div>
      {targets.map((t) => (
        <div class={`card wide ${t.enabled ? '' : 'card-off'}`} key={t.id}>
          <div class="card-head">
            <span class="name">{t.name}</span>
            <span class={`badge ${t.hasPassword ? 'ok' : 'warn'}`}>{t.hasPassword ? '✓ 凭据已配置' : '⚠ 未配置凭据'}</span>
            {!t.allowUnencrypted && <span class="badge">仅加密</span>}
            <span style="margin-left:auto">
              <Toggle checked={t.enabled} onChange={() => toggle(t)} />
            </span>
          </div>
          <div class="card-meta">{t.url} · 保留 {t.keep} 份{t.capacityQuotaMb ? ` · 配额 ${(t.capacityQuotaMb / 1024).toFixed(0)}GB` : ''} · 超时 {t.timeoutMin}min</div>
          {testResult[t.id] && <div class="banner-ok">{testResult[t.id]}</div>}
          <div class="btn-row">
            <button class="ghost sm" disabled={testing === t.id} onClick={() => testSaved(t.id)}>{testing === t.id ? '测试中…' : '测试连接'}</button>
            <button class="ghost sm" onClick={() => setEditing(t)}>编辑</button>
            <button class="ghost sm danger" onClick={() => remove(t.id)}>删除</button>
          </div>
        </div>
      ))}
    </div>
  )
}

// ---- Settings ----
function Settings() {
  const [msg, setMsg] = useState('')
  const submit = async (e: Event) => {
    e.preventDefault()
    const form = new FormData(e.target as HTMLFormElement)
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword: form.get('old'), newPassword: form.get('new') }),
      })
      setMsg('✅ 密码已修改，其他设备已登出')
    } catch (ex) {
      setMsg(`❌ ${ex instanceof Error ? ex.message : String(ex)}`)
    }
  }
  return (
    <div class="card wide">
      <div class="card-head"><span class="name">修改管理员密码</span></div>
      {msg && <div class="banner-ok">{msg}</div>}
      <form class="cred-form" onSubmit={submit}>
        <input name="old" type="password" placeholder="当前密码" required />
        <input name="new" type="password" placeholder="新密码（≥8 位）" required minlength={8} />
        <button type="submit">修改</button>
      </form>
      <div class="card-meta muted">修改后所有已登录设备强制登出（30 天记住设备）</div>
    </div>
  )
}

render(<App />, document.getElementById('app') as HTMLElement)
