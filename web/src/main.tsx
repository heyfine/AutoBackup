import { render } from 'preact'
import { useState, useEffect, useRef } from 'preact/hooks'
import { translateRunError } from './lib/translate'
import './style.css'

// ---- types（与后端对齐） ----


function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      class={`ios-toggle ${checked ? 'on' : ''}`}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      <span class="knob" />
    </button>
  )
}

/** 密码输入框：小眼睛切换明文/密文显示 */
function PasswordInput({ value, onInput, placeholder }: { value: string; onInput: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false)
  return (
    <span class="pwd-wrap">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        placeholder={placeholder}
      />
      <button
        type="button"
        class="pwd-toggle"
        title={show ? '隐藏密码' : '显示密码'}
        onClick={() => setShow(!show)}
      >
        {show ? '🙈' : '👁'}
      </button>
    </span>
  )
}

interface ProfilePart {
  kind: 'sqlite' | 'mariadb' | 'postgres' | 'directory' | 'config'
  label: string
  paths?: string[]
  container?: string
  dbPath?: string
  database?: string
  dbUser?: string
  dumpTool?: string
  dumpArgs?: string
  passwordRef?: string
  containerWorkdir?: string
  sizeBytes?: number
}

interface DetectedPart extends ProfilePart {
  source: string
  unavailable?: string
  available: boolean
}

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
  parts?: ProfilePart[]
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
  const headers: Record<string, string> = {}
  if (opts?.body) headers['Content-Type'] = 'application/json'
  const res = await fetch(path, { ...opts, headers })
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.location.hash = '#/login'
    throw new Error('unauthorized')
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error)
  return res.json() as Promise<T>
}

function partIdent(x: ProfilePart): string {
  return `${x.kind}|${x.dbPath ?? ''}|${x.database ?? ''}|${x.container ?? ''}|${(x.paths ?? []).join(',')}`
}

/** 勾选匹配：ident 相等，或目录/配置类 paths 有交集（多路径 part 与单路径候选视为同一项） */
function partMatches(selected: ProfilePart, cand: ProfilePart): boolean {
  if (partIdent(selected) === partIdent(cand)) return true
  const selPaths = selected.paths ?? []
  const candPaths = cand.paths ?? []
  if (selPaths.length > 0 && candPaths.length > 0) {
    return selPaths.some((s) => candPaths.includes(s))
  }
  return false
}

function kindLabel(k: string): string {
  switch (k) {
    case 'sqlite': return 'SQLite'
    case 'mariadb': return 'MariaDB'
    case 'postgres': return 'PostgreSQL'
    case 'config': return '配置'
    default: return '目录'
  }
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
  try {
  return <AppInner />
  } catch (e) {
  return <div style="color:red;padding:20px">APP ERROR: {String(e)}</div>
  }
}

function AppInner() {
  const [route, setRoute] = useState(window.location.hash || '#/dashboard')
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '#/dashboard')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  if (route === '#/login') return <Login />
  return <Shell route={route} />
}

// ---- Login（含首启自建） ----
function Login() {
  const [phase, setPhase] = useState<'loading' | 'login' | 'setup'>('loading')
  const [user, setUser] = useState('')
  const [pwd, setPwd] = useState('')
  const [confirm, setConfirm] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ configured: boolean }>('/auth/status')
      .then((r) => setPhase(r.configured ? 'login' : 'setup'))
      .catch(() => setPhase('login'))
  }, [])

  function enterDashboard() {
    window.location.hash = '#/dashboard'
  }

  async function submitLogin(e: Event) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await api('/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password: pwd }) })
      enterDashboard()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  async function submitSetup(e: Event) {
    e.preventDefault()
    setErr('')
    if (user.trim().length < 2) {
      setErr('用户名至少 2 个字符')
      return
    }
    if (pwd.length < 8) {
      setErr('密码至少 8 位')
      return
    }
    if (pwd !== confirm) {
      setErr('两次输入的密码不一致')
      return
    }
    setBusy(true)
    try {
      await api('/auth/setup', { method: 'POST', body: JSON.stringify({ username: user.trim(), password: pwd }) })
      enterDashboard()
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex))
    } finally {
      setBusy(false)
    }
  }

  if (phase === 'loading') {
    return (
      <div class="login-wrap">
        <div class="login-card"><h1>🔐 AutoBackup</h1></div>
      </div>
    )
  }
  const settingUp = phase === 'setup'
  return (
    <div class="login-wrap">
      <form class="login-card" onSubmit={settingUp ? submitSetup : submitLogin}>
        <h1>🔐 AutoBackup</h1>
        <p class="muted">{settingUp ? '初始化 · 创建管理员账号' : '备份中心 · 单管理员'}</p>
        <input
          type="text"
          placeholder={settingUp ? '用户名（自己定，2-32 字符）' : '用户名（未自定义过则是 admin）'}
          value={user}
          autocomplete="username"
          onInput={(e) => setUser((e.target as HTMLInputElement).value)}
          autofocus
        />
        <input
          type="password"
          placeholder={settingUp ? '设置管理员密码（≥8 位）' : '密码'}
          value={pwd}
          autocomplete={settingUp ? 'new-password' : 'current-password'}
          onInput={(e) => setPwd((e.target as HTMLInputElement).value)}
        />
        {settingUp && (
          <input
            type="password"
            placeholder="再次输入密码确认"
            value={confirm}
            autocomplete="new-password"
            onInput={(e) => setConfirm((e.target as HTMLInputElement).value)}
          />
        )}
        {err && <div class="err">{err}</div>}
        <button type="submit" disabled={busy}>{busy ? '…' : settingUp ? '创建并进入' : '登录'}</button>
        {settingUp && (
          <p class="muted" style="font-size:12px;margin:0">
            这是唯一一次创建机会：保存后入口永久关闭，此后只能凭用户名+密码登录（用户名之后可在设置页改，密码需登录才能改）。
          </p>
        )}
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


  const toggle = async (p: Profile) => {
    try {
      await api(`/api/profiles/${p.id}/toggle`, { method: 'POST' })
      await load()
    } catch {
      /* 15s 轮询会刷新 */
    }
  }

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
                <span style="margin-left:auto">
                  <Toggle checked={p.enabled} onChange={() => toggle(p)} />
                </span>
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
              {last?.error && <div class="card-err">{translateRunError(last.error)}</div>}
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
  const [autoScanning, setAutoScanning] = useState(false)
  const [restoring, setRestoring] = useState<Profile | null>(null)

  const toggle = async (p: Profile) => {
    try {
      await api(`/api/profiles/${p.id}/toggle`, { method: 'POST' })
      await load()
    } catch {
      /* 轮询会刷新 */
    }
  }

  /** 即时执行一轮自动入档扫描（与 6h 定时同逻辑）：新应用→建档且开关默认关 */
  async function scanAndAdd() {
    setAutoScanning(true)
    try {
      const r = await api<{ added: string[]; removed: string[]; error?: string }>('/api/detect/scan-now', { method: 'POST' })
      if (r.error) setMsg(`⚠️ 扫描失败：${r.error}`)
      else if (r.added.length || r.removed.length)
        setMsg(
          `✅ 自动入档 ${r.added.length} 个档案（备份开关默认关闭，核对后自行开启）${
            r.removed.length ? `，清理 ${r.removed.length} 个容器已消失的过期档案` : ''
          }`,
        )
      else setMsg('✅ 扫描完成：没有新应用（已有档案未被改动）')
      await load()
    } catch (ex) {
      setMsg(`❌ ${ex instanceof Error ? ex.message : String(ex)}`)
    } finally {
      setAutoScanning(false)
    }
  }
  const [editing, setEditing] = useState<Profile | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [msg, setMsg] = useState('')
  const [detectedParts, setDetectedParts] = useState<DetectedPart[]>([])
  const [inspecting, setInspecting] = useState(false)
  const [inspectNote, setInspectNote] = useState('')

  const inspectParts = async (prof?: Profile | null) => {
    const e = prof ?? editing
    if (!e) return
    setInspecting(true)
    setInspectNote('')
    try {
      // 识别线索 = 档案字段 + 已勾选 parts 的路径/容器（parts 里的线索最准）
      const parts = e.parts ?? []
      const allPaths = [...(e.paths ?? []), ...parts.flatMap((x) => x.paths ?? [])]
      const allContainers = [...(e.containers ?? []), ...parts.map((x) => x.container).filter(Boolean)] as string[]
      const dbPaths = [e.dbPath, ...parts.map((x) => x.dbPath).filter(Boolean)] as (string | undefined)[]
      const r = await api<{ parts: DetectedPart[]; note: string }>('/api/profiles/inspect', {
        method: 'POST',
        body: JSON.stringify({
          containers: [...new Set(allContainers)],
          dbPath: dbPaths.find(Boolean),
          dbPaths: dbPaths.filter(Boolean),
          paths: [...new Set(allPaths)],
          name: e.name,
        }),
      })
      // 已选 parts 中未被识别候选覆盖的项（如手动填的多路径配置）也显示为可勾选行
      const detected = r.parts ?? []
      const extra = (e.parts ?? []).filter((x) => !detected.some((d) => partMatches(x, d)))
        .map((x) => ({ ...x, source: (x.paths ?? [x.dbPath ?? x.container ?? '']).join(', '), available: true }) as DetectedPart)
      setDetectedParts([...detected, ...extra])
      setInspectNote(r.note ?? '')
      // 若档案还没有勾选，自动全选可用项（体验：识别即可用，可手动取消）
      if ((e.parts ?? []).length === 0) {
        const auto = (r.parts ?? []).filter((x) => x.available).map(({ source, available, unavailable, ...part }) => part)
        if (auto.length > 0) setEditing((cur) => (cur ? { ...cur, parts: auto } : cur))
      }
    } catch (ex) {
      setInspectNote(`❌ ${ex instanceof Error ? ex.message : String(ex)}`)
    } finally {
      setInspecting(false)
    }
  }

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

  const startEdit = (p: Profile | null) => {
    setIsNew(!p)
    const prof: Profile = p
      ? { ...p }
      : {
            id: '',
            name: '',
            kind: 'directory',
            paths: [],
            containers: [],
            encrypt: false,
            enabled: true,
            isDraft: false,
            schedule: { mode: 'daily', at: '03:00' },
            targetIds: [],
            keep: 7,
            recentRuns: [],
          }
    setEditing(prof)
    setDetectedParts([])
    setInspectNote('')
    // 打开编辑器即自动识别可备份类型（体验：列表直接可见，无需手动点击）
    void inspectParts(prof)
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
        </div>

        <div class="full parts-section">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
            <strong>备份内容（可多选，合并为一个压缩包）</strong>
            <button class="ghost sm" type="button" disabled={inspecting} onClick={() => inspectParts()}>
              {inspecting ? '识别中…' : '🔍 自动识别可备份类型'}
            </button>
            {inspectNote && <span class="muted" style="font-size:12px">{inspectNote}</span>}
          </div>
          {detectedParts.length > 0 && (
            <div class="parts-list">
              {detectedParts.map((dp, i) => {
                const checked = (p.parts ?? []).some((x) => partMatches(x, dp))
                return (
                  <label class="part-item" key={i}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const on = (e.target as HTMLInputElement).checked
                        const cur = p.parts ?? []
                        if (on) {
                          const { source, available, unavailable, ...part } = dp
                          upd({ parts: [...cur, part] })
                        } else {
                          upd({ parts: cur.filter((x) => !partMatches(x, dp)) })
                        }
                      }}
                    />
                    <span class="part-label">{dp.label}</span>
                    <span class="muted part-kind">{kindLabel(dp.kind)}</span>
                    <span class="part-size">{dp.sizeBytes != null ? fmtSize(dp.sizeBytes) : dp.available ? '—' : ''}</span>
                    <span class="muted part-src" title={dp.source}>{dp.source}</span>
                    {!dp.available && <span class="badge warn">{dp.unavailable ?? '不可用'}</span>}
                  </label>
                )
              })}
            </div>
          )}
          {(p.parts ?? []).length > 0 && (() => {
            // 展示粒度与勾选行一致：多路径 part 展开为单项徽章，计数 = 内容项数（非 part 对象数）
            const expanded: { label: string; title: string }[] = []
            for (const x of p.parts ?? []) {
              const paths = x.paths ?? []
              if (paths.length > 1) {
                for (const pp of paths) {
                  expanded.push({ label: `${x.label || kindLabel(x.kind)} ${pp.split('/').pop() ?? pp}`, title: pp })
                }
              } else if (paths.length === 1) {
                expanded.push({ label: `${x.label || kindLabel(x.kind)}`, title: paths[0] ?? '' })
              } else {
                expanded.push({ label: `${x.label || kindLabel(x.kind)}${x.database ? ` ${x.database}` : ''}`, title: x.dbPath ?? x.container ?? '' })
              }
            }
            return (
              <div class="parts-summary">
                <strong>已选 {expanded.length} 项：</strong>
                {expanded.map((e2, i) => (
                  <span class="sel-part" key={i} title={e2.title}>{e2.label}</span>
                ))}
                {expanded.length >= 2 && '——备份时合并为一个压缩包，还原时整体自动恢复（数据库自动停/起容器）'}
                <button class="ghost sm" type="button" onClick={() => upd({ parts: [] })}>清空</button>
              </div>
            )
          })()}
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
            <input type="checkbox" checked={p.encrypt} onChange={(e) => upd({ encrypt: (e.target as HTMLInputElement).checked })} /> age 加密（敏感数据建议开）
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
        <button class="ghost" disabled={autoScanning} onClick={() => void scanAndAdd()}>
          {autoScanning ? '扫描中…' : '🔍 立即扫描入档'}
        </button>
      </div>

      {restoring && <RestoreDialog profile={restoring} onClose={() => { setRestoring(null); load() }} />}
      {profiles.filter((p) => p.id.startsWith('auto_') && !p.enabled).length > 0 && (
        <div class="card wide detect-banner" style="margin-bottom:12px">
          <div class="card-head">
            <span class="name">🆕 {profiles.filter((p) => p.id.startsWith('auto_') && !p.enabled).length} 个自动发现的新应用待开启</span>
          </div>
          <p class="muted">
            系统每 6 小时自动扫描容器：新应用已建为档案（下方带「自动发现」徽标、开关为关，<strong>不会执行任何备份</strong>）。
            点开核对内容，确认无误后打开开关即纳入保护。
          </p>
        </div>
      )}
      <div class="cards">
        {profiles.map((p) => {
          const last = p.recentRuns[0]
          const cls = last?.status === 'success' ? 'ok' : last?.status === 'failed' ? 'bad' : 'idle'
          return (
            <div class="card" key={p.id}>
              <div class="card-head">
                <span class="name">{p.name}</span>
                {p.id.startsWith('auto_') && <span class="badge warn">自动发现</span>}
                {p.encrypt && <span class="badge">🔒</span>}
                <span style="margin-left:auto">
                  <Toggle checked={p.enabled} onChange={() => toggle(p)} />
                </span>
              </div>
              <div class="card-meta">{p.parts && p.parts.length > 0 ? p.parts.map((x) => kindLabel(x.kind)).join('+') : kindLabel(p.kind)} · {scheduleLabel(p.schedule)} · 保留 {p.keep} 份 · 目标 {p.targetIds.length === 0 ? '全部' : p.targetIds.length}</div>
              <div class="card-last">
                {last ? <><span class={`dot ${cls}`} /> {fmtTime(last.startedAt)}</> : <span class="muted">从未备份</span>}
              </div>
              <div class="btn-row">
                <button class="ghost sm" onClick={() => startEdit(p)}>编辑</button>
                <button class="ghost sm" onClick={() => setRestoring(p)}>还原/下载</button>
                <button class="ghost sm danger" onClick={() => remove(p.id)}>删除</button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---- Targets（多供应商管理） ----
function Targets() {
  const [targets, setTargets] = useState<Target[]>([])
  const [editing, setEditing] = useState<Partial<Target> & { password?: string } | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = () => api<{ targets: Target[] }>('/api/targets').then((r) => setTargets(r.targets))
  useEffect(() => {
    load()
  }, [])

  const save = async () => {
    if (!editing) return
    setMsg(null)
    try {
      await api('/api/targets', { method: 'POST', body: JSON.stringify(editing) })
      setMsg({ ok: true, text: '✅ 已保存' })
      setEditing(null)
      await load()
    } catch (ex) {
      setMsg({ ok: false, text: `❌ ${ex instanceof Error ? ex.message : String(ex)}` })
    }
  }

  const test = async (t: Partial<Target> & { password?: string }) => {
    setTesting('form')
    try {
      const r = await api<{ ok: boolean; message: string }>('/api/targets/test', {
        method: 'POST',
        body: JSON.stringify({ url: t.url, username: t.username, password: t.password, targetId: t.id }),
      })
      setTestResult((s) => ({ ...s, [t.id ?? 'form']: { ok: r.ok, message: `${r.ok ? '✅' : '❌'} ${r.message}` } }))
    } catch (ex) {
      setTestResult((s) => ({ ...s, [t.id ?? 'form']: { ok: false, message: `❌ ${ex instanceof Error ? ex.message : String(ex)}` } }))
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
      setTestResult((s) => ({ ...s, [id]: { ok: r.ok, message: `${r.ok ? '✅' : '❌'} ${r.message}` } }))
    } catch (ex) {
      setTestResult((s) => ({ ...s, [id]: { ok: false, message: `❌ ${ex instanceof Error ? ex.message : String(ex)}` } }))
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
          <label>密码 <PasswordInput value={t.password ?? ''} onInput={(v) => upd({ password: v })} placeholder={t.hasPassword ? '••••••（留空保持不变）' : '应用专用密码'} /></label>
          <label>保留份数（默认） <input type="number" min={3} max={365} value={t.keep ?? 7} onInput={(e) => upd({ keep: Number((e.target as HTMLInputElement).value) })} /></label>
          <label>容量配额 GB（可选，触发自动裁剪） <input type="number" min={0} value={t.capacityQuotaMb ? (t.capacityQuotaMb / 1024).toFixed(0) : ''} onInput={(e) => upd({ capacityQuotaMb: Number((e.target as HTMLInputElement).value) * 1024 || undefined })} placeholder="如 10" /></label>
          <label>上传超时（分钟） <input type="number" min={5} max={240} value={t.timeoutMin ?? 30} onInput={(e) => upd({ timeoutMin: Number((e.target as HTMLInputElement).value) })} /></label>
        </div>
        <label class="check-item">
          <input type="checkbox" checked={t.allowUnencrypted ?? true} onChange={(e) => upd({ allowUnencrypted: (e.target as HTMLInputElement).checked })} /> 允许未加密备份（关闭则只收加密包，强烈建议敏感服务器关闭）
        </label>
        {(() => {
          const r = testResult[t.id ?? 'form']
          return r && <div class={r.ok ? 'banner-ok' : 'banner-err'}>{r.message}</div>
        })()}
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
      {msg && <div class={msg.ok ? 'banner-ok' : 'banner-err'}>{msg.text}</div>}
      <div class="toolbar">
        <button onClick={() => setEditing({ enabled: true, keep: 7, timeoutMin: 30, allowUnencrypted: true })}>＋ 添加 WebDAV 目标</button>
      </div>
      {targets.map((t) => (
        <div class="card wide" key={t.id}>
          <div class="card-head">
            <span class="name">{t.name}</span>
            <span class={`badge ${t.hasPassword ? 'ok' : 'warn'}`}>{t.hasPassword ? '✓ 凭据已配置' : '⚠ 未配置凭据'}</span>
            {!t.enabled && <span class="badge warn">禁用</span>}
            {!t.allowUnencrypted && <span class="badge">仅加密</span>}
          </div>
          <div class="card-meta">{t.url} · 保留 {t.keep} 份{t.capacityQuotaMb ? ` · 配额 ${(t.capacityQuotaMb / 1024).toFixed(0)}GB` : ''} · 超时 {t.timeoutMin}min</div>
          {(() => {
          const r = testResult[t.id]
          return r && <div class={r.ok ? 'banner-ok' : 'banner-err'}>{r.message}</div>
        })()}
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
function AccountCard() {
  const [username, setUsername] = useState<string | null>(null)
  const [custom, setCustom] = useState(false)
  const [name, setName] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      const r = await api<{ username: string; customUsername: boolean }>('/api/account')
      setUsername(r.username)
      setCustom(r.customUsername)
    } catch {
      setUsername(null)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  async function save() {
    if (!name.trim()) return
    setBusy(true)
    try {
      const r = await api<{ username: string }>('/api/account/username', {
        method: 'POST',
        body: JSON.stringify({ username: name.trim() }),
      })
      setName('')
      setNotice({ ok: true, text: `用户名已改为「${r.username}」，下次登录起生效（当前会话不受影响）` })
      await refresh()
    } catch (ex) {
      setNotice({ ok: false, text: ex instanceof Error ? ex.message : String(ex) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="card wide">
      <div class="card-head">
        <span class="name">管理员账号</span>
        {username !== null && <span class={custom ? 'badge ok' : 'badge warn'}>{custom ? '已自定义' : '默认 admin'}</span>}
      </div>
      <div class="card-meta muted">
        当前用户名：<b>{username ?? '…'}</b>。用户名可在登录页直接输入修改；密码请在下方修改。
      </div>
      {notice && <div class={notice.ok ? 'banner-ok' : 'banner-err'}>{notice.text}</div>}
      <div class="cred-form">
        <input
          type="text"
          value={name}
          placeholder="新用户名（2-32 字符，支持中文）"
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <button disabled={!name.trim() || busy} onClick={() => void save()}>
          修改用户名
        </button>
      </div>
    </div>
  )
}

function NewAppNotifyCard() {
  const [on, setOn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<{ newAppNotify: boolean }>('/api/notify/status')
      .then((r) => setOn(r.newAppNotify))
      .catch(() => setOn(true))
  }, [])

  async function toggleTo(v: boolean) {
    setBusy(true)
    try {
      const r = await api<{ newAppNotify: boolean }>('/api/notify/prefs', {
        method: 'POST',
        body: JSON.stringify({ newAppNotify: v }),
      })
      setOn(r.newAppNotify)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="card wide">
      <div class="card-head">
        <span class="name">新应用发现通知</span>
        {on !== null && (
          <span class={on ? 'badge ok' : 'badge'}>{on ? '已开启' : '已关闭'}</span>
        )}
        <span style="margin-left:auto">
          <Toggle checked={on ?? true} onChange={(v) => void toggleTo(v)} />
        </span>
      </div>
      <div class="card-meta muted">
        开启时：自动扫描发现新应用并入档后，经 Bark/邮件推送「已加入档案，请核对」。
        关闭后：仍会<b>静默自动入档</b>（档案页徽标与横幅照常），只是不发通知——嫌打扰就关。
      </div>
      {busy && <span class="muted">保存中…</span>}
    </div>
  )
}

function BarkCard() {
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [url, setUrl] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      const r = await api<{ barkConfigured: boolean; barkEnabled: boolean }>('/api/notify/status')
      setConfigured(r.barkConfigured)
      setEnabled(r.barkEnabled)
    } catch {
      setConfigured(false)
      setEnabled(true)
    }
  }
  useEffect(() => {
    void refresh()
  }, [])

  async function toggleBark(v: boolean) {
    setBusy(true)
    try {
      const r = await api<{ barkEnabled: boolean }>('/api/notify/prefs', {
        method: 'POST',
        body: JSON.stringify({ barkEnabled: v }),
      })
      setEnabled(r.barkEnabled)
    } finally {
      setBusy(false)
    }
  }

  async function saveBark() {
    if (!url.trim()) return
    setBusy(true)
    try {
      await api('/api/notify/bark', { method: 'POST', body: JSON.stringify({ url: url.trim() }) })
      setUrl('')
      setNotice({ ok: true, text: '已保存，免重启即时生效——建议马上点「发测试通知」验证通道' })
      await refresh()
    } catch (ex) {
      setNotice({ ok: false, text: `保存失败：${ex instanceof Error ? ex.message : String(ex)}` })
    } finally {
      setBusy(false)
    }
  }

  async function testBark() {
    setBusy(true)
    try {
      const r = await api<{ sent: boolean; error?: string }>('/api/notify/test', { method: 'POST' })
      setNotice(r.sent ? { ok: true, text: '已推送 ✅ 请查看手机 Bark' } : { ok: false, text: r.error ?? '推送失败' })
    } catch (ex) {
      setNotice({ ok: false, text: `推送失败：${ex instanceof Error ? ex.message : String(ex)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="card wide">
      <div class="card-head">
        <span class="name">备份失败告警（Bark）</span>
        {configured === null ? (
          <span class="badge">加载中…</span>
        ) : configured ? (
          <span class="badge ok">已配置</span>
        ) : (
          <span class="badge warn">未配置 —— 失败不会推送</span>
        )}
        <span style="margin-left:auto">
          <Toggle checked={enabled ?? true} onChange={(v) => void toggleBark(v)} />
        </span>
      </div>
      <div class="card-meta muted">
        任何一次备份失败都会推送到手机（成功静默不打扰；持续失败每天最多一封提醒）。
        安装 iOS App <a href="https://apps.apple.com/app/bark/id1403753865">Bark</a> 获取推送 URL 后填入即可。
        开关关闭后：备份失败不再推送（配置保留，可随时重新开启；测试通知不受开关影响）。
      </div>
      {notice && <div class={notice.ok ? 'banner-ok' : 'banner-err'}>{notice.text}</div>}
      <div class="cred-form">
        <input
          type="password"
          value={url}
          onInput={(e) => setUrl(e.currentTarget.value)}
          placeholder={configured ? '输入新 URL 覆盖保存（当前值不回显）' : 'https://api.day.app/your-key'}
        />
        <button disabled={!url.trim() || busy} onClick={() => void saveBark()}>
          保存
        </button>
        <button disabled={busy || !configured} onClick={() => void testBark()}>
          发测试通知
        </button>
      </div>
      <div class="card-meta muted">URL 含设备密钥，保存后永不回显；留空保存等于关闭告警。</div>
    </div>
  )
}

interface EmailView {
  configured: boolean
  enabled: boolean
  host: string
  port: number
  user: string
  to: string
  hasPassword: boolean
}

function EmailCard() {
  const [view, setView] = useState<EmailView | null>(null)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('465')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [to, setTo] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      const r = await api<{ email: EmailView }>('/api/notify/status')
      setView(r.email)
      return r.email
    } catch {
      setView(null)
      return null
    }
  }
  useEffect(() => {
    void refresh().then((v) => {
      if (v) {
        if (v.host) setHost(v.host)
        setPort(String(v.port))
        if (v.user) setUser(v.user)
        if (v.to) setTo(v.to)
      }
    })
  }, [])

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true)
    setNotice(null)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    await withBusy(async () => {
      try {
        await api('/api/notify/email', {
          method: 'POST',
          body: JSON.stringify({ host, port: Number(port) || 465, user, to, pass: pass || undefined }),
        })
        setPass('')
        const v = await refresh()
        setNotice(
          v?.configured
            ? { ok: true, text: '已保存并即时生效——建议点「发测试邮件」验证' }
            : { ok: false, text: '已保存，但配置不完整（服务器/发件邮箱/授权码/收件邮箱缺一不可），暂不会发送邮件' },
        )
      } catch (ex) {
        setNotice({ ok: false, text: `保存失败：${ex instanceof Error ? ex.message : String(ex)}` })
      }
    })
  }

  async function test() {
    await withBusy(async () => {
      try {
        const r = await api<{ sent: boolean; error?: string }>('/api/notify/email/test', { method: 'POST' })
        setNotice(r.sent ? { ok: true, text: '测试邮件已发出 ✅ 请查收收件箱（含垃圾箱）' } : { ok: false, text: r.error ?? '发送失败' })
      } catch (ex) {
        setNotice({ ok: false, text: `发送失败：${ex instanceof Error ? ex.message : String(ex)}` })
      }
    })
  }

  async function clear() {
    await withBusy(async () => {
      try {
        await api('/api/notify/email', { method: 'POST', body: JSON.stringify({ clear: true }) })
        setView(await refresh())
        setPass('')
        setNotice({ ok: true, text: '邮箱通道已清空关闭（发件/收件/host 保留显示为空即为已清）' })
      } catch (ex) {
        setNotice({ ok: false, text: `操作失败：${ex instanceof Error ? ex.message : String(ex)}` })
      }
    })
  }

  async function toggleEmail(v: boolean) {
    await withBusy(async () => {
      const r = await api<{ emailEnabled: boolean }>('/api/notify/prefs', {
        method: 'POST',
        body: JSON.stringify({ emailEnabled: v }),
      })
      setView((cur) => (cur ? { ...cur, enabled: r.emailEnabled } : cur))
    })
  }

  return (
    <div class="card wide">
      <div class="card-head">
        <span class="name">备份失败告警（邮箱 SMTP）</span>
        {view === null ? (
          <span class="badge">加载中…</span>
        ) : view.configured ? (
          <span class="badge ok">已配置</span>
        ) : (
          <span class="badge warn">未配置</span>
        )}
        <span style="margin-left:auto">
          <Toggle checked={view?.enabled ?? true} onChange={(v) => void toggleEmail(v)} />
        </span>
      </div>
      <div class="card-meta muted">
        与 Bark 并行的第二告警通道：备份失败同时发 email（持续失败每天最多一封提醒）。
        以 QQ 邮箱为例：设置→账号→POP3/SMTP→开启并取<strong>授权码</strong>（不是登录密码），host 填 smtp.qq.com、port 465。
        开关关闭后：备份失败不再发邮件（配置保留，可随时重新开启；测试邮件不受开关影响）。
      </div>
      {notice && <div class={notice.ok ? 'banner-ok' : 'banner-err'}>{notice.text}</div>}
      <div class="form-grid">
        <label>
          SMTP 服务器
          <input value={host} onInput={(e) => setHost(e.currentTarget.value)} placeholder="smtp.qq.com（裸域名，不要 http:// 前缀）" />
        </label>
        <label>
          端口
          <input value={port} onInput={(e) => setPort(e.currentTarget.value)} placeholder="465" />
        </label>
        <label>
          发件邮箱
          <input value={user} onInput={(e) => setUser(e.currentTarget.value)} placeholder="you@qq.com" />
        </label>
        <label>
          收件邮箱
          <input value={to} onInput={(e) => setTo(e.currentTarget.value)} placeholder="you@qq.com" />
        </label>
        <label class="full">
          授权码{view?.hasPassword ? '（已保存，留空=保持不变）' : ''}
          <input type="password" value={pass} onInput={(e) => setPass(e.currentTarget.value)} placeholder="SMTP 授权码，非邮箱登录密码" />
        </label>
      </div>
      <div class="btn-row">
        <button disabled={busy || !(host && user && to) || (!view?.hasPassword && !pass)} onClick={() => void save()}>
          保存
        </button>
        <button disabled={busy || !view?.configured} onClick={() => void test()}>
          发测试邮件
        </button>
        <button disabled={busy || !view?.host} onClick={() => void clear()}>
          清空配置
        </button>
      </div>
      <div class="card-meta muted">授权码保存后永不回显；465 走 SSL，587 走 STARTTLS。</div>
    </div>
  )
}

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
    <>
      <AccountCard />
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
      <NewAppNotifyCard />
      <BarkCard />
      <EmailCard />
    </>
  )
}

try {
  render(<App />, document.getElementById('app') as HTMLElement)
} catch (e) {
  document.body.innerText = 'BOOT ERROR: ' + (e instanceof Error ? e.stack?.slice(0, 500) : String(e))
}


// ---- RestoreDialog（还原/下载） ----
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
  const [result, setResult] = useState<{ steps: string[]; preRestoreBackup?: string; mode: string } | null>(null)
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
      const r = await api<{ steps: string[]; preRestoreBackup?: string; mode: string }>(
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
          <span class="name">还原/下载：{profile.name}</span>
          <button class="ghost sm" onClick={onClose}>✕</button>
        </div>
        {result ? (
          <div>
            <div class="statusbar ok">{result.mode === 'preview' ? '✅ 预览解包完成（生产数据未动）' : '✅ 正式还原完成'}</div>
            <ol class="steps">
              {result.steps.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
            {result.preRestoreBackup && <div class="banner-ok">还原前数据已兜底：{result.preRestoreBackup}</div>}
            <div class="btn-row"><button onClick={onClose}>关闭</button></div>
          </div>
        ) : (
          <div>
            <p class="muted">选择快照（仅显示本地还存在的）：行尾可下载备份包到你的设备。</p>
            {artifacts.length === 0 && <div class="muted">没有可用的本地快照。</div>}
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
                      <a href={`/api/artifacts/download?runId=${encodeURIComponent(a.runId)}`} class="ghost sm dl-btn">⬇ 包</a>
                      <a href={`/api/artifacts/download?path=${encodeURIComponent(a.artifactPath.replace(/\.tar\.gz(\.age)?$/, '.manifest.json'))}`} class="ghost sm dl-btn">清单</a>
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
                <p>将覆盖档案「<strong>{profile.name}</strong>」的现有数据（还原前自动兜底备份）。</p>
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
