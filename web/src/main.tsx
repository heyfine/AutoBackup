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
interface Profile {
  id: string
  name: string
  kind: string
  encrypt: boolean
  enabled: boolean
  isDraft: boolean
  scheduleAt?: string
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
}

// ---- API helpers ----
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts })
  if (res.status === 401) {
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

// ---- Shell（顶栏 + 路由） ----
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
          <a href="#/targets" class={route.startsWith('#/targets') ? 'on' : ''}>WebDAV 目标</a>
          <a href="#/settings" class={route.startsWith('#/settings') ? 'on' : ''}>设置</a>
        </nav>
        <button class="ghost" onClick={logout}>退出</button>
      </header>
      <main>
        {route.startsWith('#/dashboard') && <Dashboard />}
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

  const allOk = profiles.every((p) => !p.recentRuns[0] || p.recentRuns[0].status === 'success')
  const lastAny = profiles
    .flatMap((p) => (p.recentRuns[0] ? [p.recentRuns[0].startedAt] : []))
    .sort()
    .pop()

  return (
    <div>
      <div class={`statusbar ${allOk ? 'ok' : 'bad'}`}>
        {allOk ? `✅ 全部正常 · 最近备份 ${fmtTime(lastAny)}` : `❌ 存在失败任务 · 请查看下方卡片`}
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
                <span>{p.kind}</span>
                {p.scheduleAt && <span>· {p.scheduleAt}</span>}
              </div>
              <div class="card-last">
                {last ? (
                  <>
                    <span class={`dot ${cls}`} /> {status} · {fmtTime(last.startedAt)} · {fmtSize(last.sizeBytes)}
                  </>
                ) : (
                  <span class="muted">从未备份</span>
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

// ---- Targets ----
function Targets() {
  const [targets, setTargets] = useState<Target[]>([])
  const [msg, setMsg] = useState('')
  const load = () => api<{ targets: Target[] }>('/api/targets').then((r) => setTargets(r.targets))
  useEffect(() => {
    load()
  }, [])

  const save = async (t: Target, form: FormData) => {
    setMsg('')
    try {
      await api(`/api/targets/${t.id}/credentials`, {
        method: 'POST',
        body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
      })
      setMsg('✅ 凭据已保存')
      await load()
    } catch (ex) {
      setMsg(`❌ ${ex instanceof Error ? ex.message : String(ex)}`)
    }
  }

  return (
    <div>
      {msg && <div class="banner-ok">{msg}</div>}
      {targets.map((t) => (
        <div class="card wide" key={t.id}>
          <div class="card-head">
            <span class="name">{t.name}</span>
            <span class={`badge ${t.hasPassword ? 'ok' : 'warn'}`}>{t.hasPassword ? '✓ 已配置' : '⚠ 未配置凭据'}</span>
            {!t.enabled && <span class="badge warn">禁用</span>}
          </div>
          <div class="card-meta">{t.url}</div>
          <form
            class="cred-form"
            onSubmit={(e) => {
              e.preventDefault()
              void save(t, new FormData(e.target as HTMLFormElement))
            }}
          >
            <input name="username" placeholder={t.username && !t.username.startsWith('PLACE') ? t.username : 'WebDAV 用户名'} defaultValue={t.username?.startsWith('PLACE') ? '' : t.username} />
            <input name="password" type="password" placeholder={t.hasPassword ? '••••••（留空保持不变）' : '应用专用密码'} />
            <button type="submit">保存凭据</button>
          </form>
          <div class="card-meta muted">keep={t.keep} · 配额 {t.capacityQuotaMb ? `${(t.capacityQuotaMb / 1024).toFixed(0)}GB` : '未设'}</div>
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
