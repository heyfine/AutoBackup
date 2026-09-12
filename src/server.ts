import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, renameSync, createReadStream } from 'node:fs'
import type { Store } from './store/db.js'
import type { Pipeline } from './core/pipeline.js'
import type { Scheduler } from './core/scheduler.js'
import type { Secrets } from './core/secrets.js'
import { emailConfigFromSecrets, normalizeSmtpHost } from './core/notifier.js'
import type { AlertHub } from './core/notifier.js'
import type { AppProfile, BackupTarget, DetectedDraft, RunRecord } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Web API（M3）：单管理员 session 认证 + SSE 进度。
 * 安全（评审 D5/designer 方案）：GET 永不返回密码；登录限频；cookie HttpOnly+SameSite。
 */
export interface ApiDeps {
  store: Store
  pipeline: Pipeline
  scheduler: Scheduler
  secrets: Secrets
  secretsPath: string
  notify: AlertHub
  port: number
}

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000 // designer 方案：30 天记住设备

interface Session {
  token: string
  expiresAt: number
}

export class AdminAuth {
  private sessions = new Map<string, Session>()
  private loginAttempts: { count: number; resetAt: number } = { count: 0, resetAt: 0 }
  readonly passwordFile: string
  readonly usernameFile: string

  constructor(private readonly homeDir: string) {
    this.passwordFile = join(homeDir, 'admin-password.txt')
    this.usernameFile = join(homeDir, 'admin-username.txt')
  }

  /** 是否已自定义用户名（未自定义时登录用默认 admin，兼容纯密码时代存量部署） */
  hasCustomUsername(): boolean {
    return existsSync(this.usernameFile)
  }

  getUsername(): string {
    if (!this.hasCustomUsername()) return 'admin'
    try {
      return readFileSync(this.usernameFile, 'utf8').trim() || 'admin'
    } catch {
      return 'admin'
    }
  }

  /** 用户名规则：2-32 字符，禁止路径/控制字符；允许中文 */
  static isValidUsername(name: string): boolean {
    return name.length >= 2 && name.length <= 32 && !/[\\/:*?"<>|\x00-\x1f\s]/.test(name)
  }

  /** 管理员密码是否已创建（UI 据此决定显示「登录」还是「首次创建」） */
  isConfigured(): boolean {
    return existsSync(this.passwordFile)
  }

  private static atomicWrite(file: string, content: string): void {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, content, { mode: 0o600 })
    renameSync(tmp, file)
  }

  /**
   * 首启自建：仅当从未创建过密码时可写——成功一次后窗口永久关闭。
   * 用户名与密码一并创建（用户名文件独立存放，密码文件保持「manually 放置即登录」老路径兼容）。
   */
  setupAccount(username: string, newPwd: string): boolean {
    if (this.isConfigured()) return false
    const name = username.trim()
    if (!AdminAuth.isValidUsername(name) || newPwd.length < 8) return false
    AdminAuth.atomicWrite(this.usernameFile, name)
    AdminAuth.atomicWrite(this.passwordFile, newPwd)
    return true
  }

  /** 登录后可随时改用户名（用户名非机密，不参与「一次性窗口」） */
  changeUsername(name: string): string | null {
    const trimmed = name.trim()
    if (!AdminAuth.isValidUsername(trimmed)) return null
    AdminAuth.atomicWrite(this.usernameFile, trimmed)
    return trimmed
  }

  private static safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a)
    const y = Buffer.from(b)
    return x.length === y.length && timingSafeEqual(x, y)
  }

  private verifyPassword(pwd: string): boolean {
    if (!existsSync(this.passwordFile)) return false
    return AdminAuth.safeEqual(pwd, readFileSync(this.passwordFile, 'utf8').trim())
  }

  /** 登录校验：用户名+密码联合判定，合并计入限频（防用户名爆破）；不回显哪个错 */
  login(inputUser: string, inputPwd: string): boolean {
    const now = Date.now()
    if (now < this.loginAttempts.resetAt && this.loginAttempts.count >= 5) return false
    const ok =
      this.isConfigured() &&
      AdminAuth.safeEqual(inputUser.trim(), this.getUsername()) &&
      this.verifyPassword(inputPwd)
    if (now >= this.loginAttempts.resetAt) {
      this.loginAttempts = { count: 0, resetAt: now + 10 * 60 * 1000 }
    }
    if (!ok) this.loginAttempts.count++
    return ok
  }

  changePassword(oldPwd: string, newPwd: string): boolean {
    if (!this.verifyPassword(oldPwd)) return false
    if (newPwd.length < 8) return false
    AdminAuth.atomicWrite(this.passwordFile, newPwd)
    this.sessions.clear() // 全端登出（改密不重置限频计数：登录限频是防爆破而非防自己）
    return true
  }

  createSession(): string {
    const token = randomBytes(24).toString('base64url')
    this.sessions.set(token, { token, expiresAt: Date.now() + SESSION_TTL_MS })
    return token
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false
    const s = this.sessions.get(token)
    if (!s) return false
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(token)
      return false
    }
    return true
  }
}

export async function startApi(deps: ApiDeps): Promise<{ port: number; auth: AdminAuth; stop: () => Promise<void> }> {
  const { store, scheduler, secrets, secretsPath, notify, port } = deps
  const auth = new AdminAuth(process.env.AUTOBACKUP_HOME ?? process.cwd())
  if (!auth.isConfigured()) {
    console.log('[autobackup] 管理员尚未初始化：打开 Web 控制台即可创建管理员密码（一次性窗口，创建后关闭）')
  }

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 })

  // 认证钩子：/auth/*、/health、静态资源之外全部要求 session
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? ''
    if (path.startsWith('/auth/') || path === '/health' || path === '/' || path.startsWith('/assets/')) return
    const cookie = req.headers.cookie ?? ''
    const token = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('ab_session='))?.slice('ab_session='.length)
    if (!auth.isValid(token)) {
      await reply.code(401).send({ error: 'unauthorized' })
    }
  })

  // ---- auth ----
  /** 首启状态：UI 据此显示「创建管理员密码」或「登录」；不回显任何凭据 */
  app.get('/auth/status', async () => ({ configured: auth.isConfigured() }))

  /** 一次性自建：仅未初始化时可调用，成功即关闭入口并直接登录 */
  app.post('/auth/setup', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    if (auth.isConfigured()) {
      await reply.code(403).send({ error: '管理员已初始化，创建入口已关闭' })
      return
    }
    if (!username || !AdminAuth.isValidUsername(username.trim())) {
      await reply.code(400).send({ error: '用户名需 2-32 字符（不含空格及特殊字符）' })
      return
    }
    if (!password || password.length < 8) {
      await reply.code(400).send({ error: '密码至少 8 位' })
      return
    }
    if (!auth.setupAccount(username, password)) {
      await reply.code(409).send({ error: '创建失败（可能已被初始化），请刷新重试' })
      return
    }
    const token = auth.createSession()
    reply.header(
      'Set-Cookie',
      `ab_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    )
    return { ok: true }
  })

  app.post('/auth/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    if (!password || !auth.login(username ?? '', password)) {
      await reply.code(401).send({ error: '用户名或密码错误' })
      return
    }
    const token = auth.createSession()
    reply.header(
      'Set-Cookie',
      `ab_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
    )
    return { ok: true }
  })

  app.post('/auth/logout', async (req, reply) => {
    const cookie = req.headers.cookie ?? ''
    const token = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith('ab_session='))?.slice('ab_session='.length)
    if (token) {
      ;(auth as unknown as { sessions: Map<string, Session> }).sessions.delete(token)
    }
    reply.header('Set-Cookie', 'ab_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
    return { ok: true }
  })

  app.post('/auth/change-password', async (req, reply) => {
    const { oldPassword, newPassword } = (req.body ?? {}) as { oldPassword?: string; newPassword?: string }
    if (!oldPassword || !newPassword || !auth.changePassword(oldPassword, newPassword)) {
      await reply.code(400).send({ error: '修改失败（旧密码错误或新密码不足 8 位）' })
      return
    }
    return { ok: true }
  })

  // ---- 账号（登录后路由，受 session 保护；用户名非机密可回显） ----
  app.get('/api/account', async () => ({ username: auth.getUsername(), customUsername: auth.hasCustomUsername() }))

  app.post('/api/account/username', async (req, reply) => {
    const { username } = (req.body ?? {}) as { username?: string }
    const saved = username ? auth.changeUsername(username) : null
    if (!saved) {
      await reply.code(400).send({ error: '用户名需 2-32 字符（不含空格及特殊字符）' })
      return
    }
    return { username: saved }
  })

  app.get('/health', async () => ({ ok: true, version: '0.1.0' }))
  // ---- profiles（只读 + 手动触发；M3 不做档案编辑 UI）----
  // ---- profiles（产品化：完整 CRUD）----
  app.get('/api/profiles', async () => {
    const profiles = store.listProfiles({ includeDrafts: true })
    const result = profiles.map((p: AppProfile) => {
      const runs = store.listRuns(p.id, 3)
      return { ...p, passwordRef: p.passwordRef ? '***' : undefined, recentRuns: runs.map(pickRunPublic) }
    })
    return { profiles: result }
  })

  /** 新建/更新档案（产品化：完整字段编辑，含 schedule/targetIds/keep） */
  app.post('/api/profiles', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<AppProfile> & { id?: string }
    let profile: AppProfile
    if (body.id) {
      const existing = store.getProfile(body.id)
      if (!existing) {
        await reply.code(404).send({ error: 'profile not found' })
        return
      }
      profile = {
        ...existing,
        ...body,
        id: existing.id,
      } as AppProfile
    } else {
      profile = {
        id: body.id ?? `p_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
        name: body.name ?? '未命名档案',
        kind: body.kind ?? 'directory',
        parts: body.parts,
        paths: body.paths ?? [],
        containers: body.containers ?? [],
        dbPath: body.dbPath,
        database: body.database,
        dbUser: body.dbUser,
        dumpTool: body.dumpTool,
        dumpArgs: body.dumpArgs,
        passwordRef: body.passwordRef,
        containerWorkdir: body.containerWorkdir,
        encrypt: body.encrypt ?? false,
        consistency: body.consistency ?? 'best_effort',
        schedule: body.schedule ?? { mode: 'daily', at: '03:00' },
        targetIds: body.targetIds ?? [],
        keep: body.keep ?? 7,
        enabled: body.enabled ?? true,
        isDraft: false,
      }
    }
    // 校验 schedule
    const s = profile.schedule
    if (s.mode === 'daily' && !/^\d{2}:\d{2}$/.test(s.at)) {
      await reply.code(400).send({ error: 'daily 频率的 at 必须是 HH:mm' })
      return
    }
    if (s.mode === 'interval' && (s.hours < 1 || s.hours > 168)) {
      await reply.code(400).send({ error: 'interval 频率的 hours 必须在 1-168' })
      return
    }
    // 多类型模式校验：至少勾选一项
    if (Array.isArray(profile.parts)) {
      if (profile.parts.length === 0) {
        await reply.code(400).send({ error: '多类型模式至少要勾选一项备份内容' })
        return
      }
      for (const part of profile.parts) {
        if ((part.kind === 'directory' || part.kind === 'config') && !(part.paths && part.paths.length > 0)) {
          await reply.code(400).send({ error: `子项「${part.label}」缺少路径` })
          return
        }
        if (part.kind === 'sqlite' && !part.dbPath) {
          await reply.code(400).send({ error: `子项「${part.label}」缺少数据库文件路径` })
          return
        }
        if ((part.kind === 'mariadb' || part.kind === 'postgres') && !part.container) {
          await reply.code(400).send({ error: `子项「${part.label}」缺少容器名` })
          return
        }
      }
      // 校验通过后按第一个 part 的 kind 作为主 kind（兼容旧 UI 展示与调度）
      const firstPart = profile.parts[0]
      if (firstPart) profile.kind = firstPart.kind
    } else if (profile.kind === 'directory' && profile.paths.length === 0) {
      await reply.code(400).send({ error: '目录类档案至少要有一个路径' })
      return
    }
    store.upsertProfile(profile)
    return { profile }
  })

  app.delete('/api/profiles/:id', async (req) => {
    const { id } = req.params as { id: string }
    store.deleteProfile(id)
    return { ok: true }
  })

  /** 启停开关（卡片 toggle） */
  app.post('/api/profiles/:id/toggle', async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = store.getProfile(id)
    if (!existing) {
      await reply.code(404).send({ error: 'profile not found' })
      return
    }
    const updated = { ...existing, enabled: !existing.enabled }
    store.upsertProfile(updated)
    return { profile: updated }
  })

  /** 一键采纳 detector 草稿（确认后建档案，enabled=false 由用户再开） */
  app.post('/api/profiles/adopt', async (req, reply) => {
    const body = (req.body ?? {}) as { draft: DetectedDraft; overrides?: Partial<AppProfile> }
    const d = body.draft
    if (!d?.containerName || !d.suggestedProfile) {
      await reply.code(400).send({ error: 'draft 数据不完整' })
      return
    }
    const profile: AppProfile = {
      id: `p_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
      name: d.suggestedProfile.name ?? d.containerName,
      kind: d.suggestedProfile.kind ?? 'directory',
      paths: d.suggestedProfile.paths ?? [],
      containers: d.suggestedProfile.containers ?? [d.containerName],
      dbPath: d.suggestedProfile.dbPath,
      database: d.suggestedProfile.database,
      dbUser: d.suggestedProfile.dbUser,
      dumpTool: d.suggestedProfile.dumpTool,
      dumpArgs: d.suggestedProfile.dumpArgs,
      encrypt: d.suggestedProfile.encrypt ?? false,
      consistency: d.suggestedProfile.consistency ?? 'best_effort',
      schedule: { mode: 'daily', at: '03:00' },
      targetIds: [],
      keep: 7,
      enabled: false, // 采纳后默认停用，用户编辑确认后自己开启
      isDraft: false,
      ...body.overrides,
    }
    store.upsertProfile(profile)
    return { profile }
  })

  /** 新应用检测（docker 容器 → 草稿建议，UI 编辑器按需，不落库） */
  app.post('/api/detect', async () => {
    const { detectContainers } = await import('./core/detector.js')
    const profiles = store.listProfiles({ includeDrafts: true })
    const covered = profiles.flatMap((p) => p.containers)
    try {
      const result = await detectContainers(covered)
      return result
    } catch (err) {
      return { drafts: [], scanned: 0, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 手动执行一轮「自动入档」扫描（与 6h 定时同逻辑）：新应用→档案 enabled=false */
  app.post('/api/detect/scan-now', async () => {
    const { scanAndRegister } = await import('./core/auto-detect.js')
    try {
      return await scanAndRegister(store, notify)
    } catch (err) {
      return { added: [], removed: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 类型自动识别（编辑器多选数据源）：按容器/路径探测可备份类型 + 大小 */
  app.post('/api/profiles/inspect', async (req) => {
    const body = (req.body ?? {}) as { containers?: string[]; dbPath?: string; paths?: string[]; name?: string }
    const { inspectProfileParts } = await import('./core/inspector.js')
    try {
      return await inspectProfileParts(body)
    } catch (err) {
      return { parts: [], note: `探测失败：${err instanceof Error ? err.message : String(err)}` }
    }
  })

  app.post('/api/profiles/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string }
    try {
      const run = (await scheduler.runNow(id)) as RunRecord
      return pickRunPublic(run)
    } catch (err) {
      await reply.code(409).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ---- targets（产品化：完整 CRUD，凭据只回 has_password）----
  app.get('/api/targets', async () => {
    const targets = store.listTargets(false)
    return { targets: targets.map((t: BackupTarget) => ({ ...t, passwordRef: '***' as const, hasPassword: secrets.has(t.passwordRef) })) }
  })

  /** 新建/更新目标（无密码时保留旧凭据） */
  app.post('/api/targets', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<BackupTarget> & { id?: string; password?: string; testOnly?: boolean }
    const isNew = !body.id
    let target: BackupTarget
    if (isNew) {
      const { id, passwordRef } = store.newTargetId(body.name ?? 'webdav')
      target = {
        id,
        name: body.name ?? '未命名目标',
        url: body.url ?? '',
        username: body.username ?? '',
        passwordRef,
        enabled: body.enabled ?? true,
        keep: body.keep ?? 7,
        capacityQuotaMb: body.capacityQuotaMb,
        capacityWarnPct: body.capacityWarnPct ?? 85,
        timeoutMin: body.timeoutMin ?? 30,
        allowUnencrypted: body.allowUnencrypted ?? true,
      }
      if (body.password) {
        upsertSecret(passwordRef, body.password)
        ;(secrets as unknown as { values: Map<string, string> }).values.set(passwordRef, body.password)
      }
      if (body.username) upsertSecret(`WEBDAV_${id.toUpperCase().replace(/-/g, '_')}_USER`, body.username)
      store.upsertTarget(target)
    } else {
      const existing = store.getTarget(body.id as string)
      if (!existing) {
        await reply.code(404).send({ error: 'target not found' })
        return
      }
      target = {
        ...existing,
        name: body.name ?? existing.name,
        url: body.url ?? existing.url,
        username: body.username ?? existing.username,
        enabled: body.enabled ?? existing.enabled,
        keep: body.keep ?? existing.keep,
        capacityQuotaMb: body.capacityQuotaMb,
        capacityWarnPct: body.capacityWarnPct ?? existing.capacityWarnPct,
        timeoutMin: body.timeoutMin ?? existing.timeoutMin,
        allowUnencrypted: body.allowUnencrypted ?? existing.allowUnencrypted,
      }
      if (body.password) {
        upsertSecret(existing.passwordRef, body.password)
        ;(secrets as unknown as { values: Map<string, string> }).values.set(existing.passwordRef, body.password)
      }
      if (body.username) upsertSecret(`WEBDAV_${existing.id.toUpperCase().replace(/-/g, '_')}_USER`, body.username)
      store.upsertTarget(target)
    }
    const saved = store.getTarget(target.id)
    return { target: saved ? { ...saved, passwordRef: '***', hasPassword: secrets.has(saved.passwordRef) } : null }
  })

  app.delete('/api/targets/:id', async (req) => {
    const { id } = req.params as { id: string }
    store.deleteTarget(id)
    return { ok: true }
  })

  /** 目标启停开关（卡片 toggle） */
  app.post('/api/targets/:id/toggle', async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = store.getTarget(id)
    if (!existing) {
      await reply.code(404).send({ error: 'target not found' })
      return
    }
    const updated = { ...existing, enabled: !existing.enabled }
    store.upsertTarget(updated)
    return { target: { ...updated, passwordRef: '***', hasPassword: secrets.has(updated.passwordRef) } }
  })

  /** WebDAV 连接测试（用已存凭据或请求体里的临时凭据） */
  app.post('/api/targets/test', async (req) => {
    const body = (req.body ?? {}) as { url?: string; username?: string; password?: string; targetId?: string }
    const { testConnection } = await import('./core/webdav.js')
    let url = body.url
    let username = body.username
    let password = body.password
    if (body.targetId && (!url || !password)) {
      const t = store.getTarget(body.targetId)
      if (t) {
        url = url ?? t.url
        username = username ?? t.username
        password = password ?? secrets.getOptional(t.passwordRef)
      }
    }
    if (!url) return { ok: false, message: '缺少 URL' }
    const result = await testConnection({ url, username: username ?? '', password: password ?? '' })
    return result
  })

  /** secrets.env 原子写单键 */
  function upsertSecret(key: string, value: string): void {
    const lines = readFileSync(secretsPath, 'utf8').split(/\r?\n/)
    const updated: string[] = []
    let wrote = false
    for (const line of lines) {
      if (line.split('=')[0]?.trim() === key) {
        updated.push(`${key}=${value}`)
        wrote = true
      } else updated.push(line)
    }
    if (!wrote) updated.push(`${key}=${value}`)
    const tmp = `${secretsPath}.tmp`
    writeFileSync(tmp, updated.join('\n'), { mode: 0o600 })
    renameSync(tmp, secretsPath)
    ;(secrets as unknown as { values: Map<string, string> }).values.set(key, value)
  }

  // ---- 告警通知（Bark 推送 + Email/SMTP 双通道）----
  /** 邮箱通道视图：host/发件人/收件人非机密可回显；授权码按凭据处理永不回显 */
  function emailView() {
    const cfg = emailConfigFromSecrets(secrets)
    return {
      configured: cfg !== null,
      host: normalizeSmtpHost(secrets.getOptional('SMTP_HOST') ?? ''),
      port: Number(secrets.getOptional('SMTP_PORT') ?? '465') || 465,
      user: secrets.getOptional('SMTP_USER') ?? '',
      to: secrets.getOptional('MAIL_TO') ?? '',
      hasPassword: secrets.has('SMTP_PASS'),
    }
  }

  app.get('/api/notify/status', async () => ({ barkConfigured: secrets.has('BARK_URL'), email: emailView() }))

  app.post('/api/notify/bark', async (req) => {
    const { url } = (req.body ?? {}) as { url?: string }
    upsertSecret('BARK_URL', url?.trim() ?? '')
    return { barkConfigured: secrets.has('BARK_URL') }
  })

  /** 发一条测试推送到 Bark，验证告警通道真实可达（失败必告警的闭环入口） */
  app.post('/api/notify/test', async () => {
    const ch = notify.channel('bark')
    if (!ch || !ch.isConfigured()) {
      return { sent: false, error: '未配置 BARK_URL' }
    }
    const sent = await ch.send('test', '✅ 测试通知：AutoBackup 告警通道已连通', 'active')
    return { sent, error: sent ? undefined : ch.lastError || 'Bark 投递失败（检查网络/密钥/服务状态）' }
  })

  /** 保存 SMTP 邮箱通道配置（原子写 secrets，热生效）。pass 留空=保持现值；clear=true 一键清空 */
  app.post('/api/notify/email', async (req) => {
    const b = (req.body ?? {}) as { host?: string; port?: number | string; user?: string; pass?: string; to?: string; clear?: boolean }
    if (b.clear) {
      upsertSecret('SMTP_HOST', '')
      upsertSecret('SMTP_PORT', '')
      upsertSecret('SMTP_USER', '')
      upsertSecret('SMTP_PASS', '')
      upsertSecret('MAIL_TO', '')
      return { email: emailView() }
    }
    if (b.host !== undefined) upsertSecret('SMTP_HOST', normalizeSmtpHost(b.host))
    if (b.port !== undefined) upsertSecret('SMTP_PORT', String(Number(b.port) || 465))
    if (b.user !== undefined) upsertSecret('SMTP_USER', b.user.trim())
    if (b.to !== undefined) upsertSecret('MAIL_TO', b.to.trim())
    if (b.pass) upsertSecret('SMTP_PASS', b.pass) // 授权码空值不覆盖，支持「只改收件人」场景
    return { email: emailView() }
  })

  app.post('/api/notify/email/test', async () => {
    const ch = notify.channel('email')
    if (!ch || !ch.isConfigured()) {
      return { sent: false, error: 'SMTP 配置不完整（服务器/发件邮箱/授权码/收件邮箱 均必填）' }
    }
    const sent = await ch.send('test', '✅ 测试邮件：AutoBackup 邮箱告警通道已连通', 'active')
    return { sent, error: sent ? undefined : ch.lastError || '邮件投递失败（检查网络/端口/授权码）' }
  })

  // ---- targets 凭据快捷更新（兼容 M3 早期 UI）----
  app.post('/api/targets/:id/credentials', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string }
    const target = store.getTarget(id)
    if (!target) {
      await reply.code(404).send({ error: 'target not found' })
      return
    }
    if (password) upsertSecret(target.passwordRef, password)
    if (username) {
      upsertSecret(`WEBDAV_${id.toUpperCase().replace(/-/g, '_')}_USER`, username)
      store.upsertTarget({ ...target, username })
    }
    return { ok: true }
  })

  // ---- restore（还原，方案 D4 / 用户需求）----
  /** 下载 artifact 到本地设备（浏览器下载流；用户需求：备份下载到我的设备） */
  app.get('/api/artifacts/download', async (req, reply) => {
    const q = req.query as { runId?: string; path?: string }
    const homeDir = process.env.AUTOBACKUP_HOME ?? process.cwd()
    let artifactPath = q.path
    if (q.runId) {
      const run = store.getRun(q.runId)
      artifactPath = run?.localPath
    }
    if (!artifactPath || !existsSync(artifactPath)) {
      await reply.code(404).send({ error: 'artifact 不存在' })
      return
    }
    // 路径安全：只允许 homeDir 内的文件（防目录穿越拿任意文件）
    const normalized = join(artifactPath)
    if (!normalized.startsWith(homeDir)) {
      await reply.code(403).send({ error: 'forbidden' })
      return
    }
    const fileName = artifactPath.split(/[\\/]/).pop() ?? 'backup.tar.gz'
    const manifestPath = artifactPath.replace(/\.tar\.gz(\.age)?$/, '.manifest.json')
    if (req.headers.range) {
      // 大文件支持断点（浏览器下载一般不用，但 curl/wget 会用）
      const range = req.headers.range
      const fsMod = await import('node:fs')
      const size = fsMod.statSync(artifactPath).size
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      const start = m?.[1] ? Number(m[1]) : 0
      const end = m?.[2] ? Number(m[2]) : size - 1
      const stream = fsMod.createReadStream(artifactPath, { start, end })
      reply.header('Content-Range', `bytes ${start}-${end}/${size}`)
      reply.header('Accept-Ranges', 'bytes')
      reply.header('Content-Length', String(end - start + 1))
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      reply.code(206)
      return reply.send(stream)
    }
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    reply.header('Accept-Ranges', 'bytes')
    // manifest 伴随提示由 UI 侧单独下载
    void manifestPath
    return reply.send(createReadStream(artifactPath))
  })

  /** 某档案可还原的本地快照列表 */
  app.get('/api/profiles/:id/artifacts', async (req, reply) => {
    const { id } = req.params as { id: string }
    const profile = store.getProfile(id)
    if (!profile) {
      await reply.code(404).send({ error: 'profile not found' })
      return
    }
    const homeDir = process.env.AUTOBACKUP_HOME ?? process.cwd()
    const artifacts = store
      .listRuns(id, 30)
      .filter((r) => r.localPath && r.status === 'success')
      .map((r) => ({
        runId: r.id,
        artifactPath: r.localPath,
        sizeBytes: r.sizeBytes,
        sha256: r.sha256,
        encrypted: r.encrypted,
        startedAt: r.startedAt,
        exists: existsSync(r.localPath as string),
      }))
    void homeDir
    return { artifacts }
  })

  /** 还原（preview 解包预览 / inplace 正式覆盖，RED 级确认） */
  app.post('/api/profiles/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as { runId?: string; artifactPath?: string; mode?: 'preview' | 'inplace'; confirmName?: string }
    const profile = store.getProfile(id)
    if (!profile) {
      await reply.code(404).send({ error: 'profile not found' })
      return
    }
    // 找 artifact：优先 runId，其次直接路径
    let artifactPath = body.artifactPath
    if (!artifactPath && body.runId) {
      const run = store.getRun(body.runId)
      artifactPath = run?.localPath
    }
    if (!artifactPath || !existsSync(artifactPath)) {
      await reply.code(400).send({ error: 'artifact 不存在（本地文件已被清理？）' })
      return
    }
    const mode = body.mode === 'inplace' ? 'inplace' : 'preview'
    if (mode === 'inplace' && body.confirmName !== profile.name) {
      await reply.code(400).send({ error: `RED 级确认失败：请输入档案名「${profile.name}」原文` })
      return
    }
    const { restoreProfile, auditRestore } = await import('./core/restore.js')
    const homeDir = process.env.AUTOBACKUP_HOME ?? process.cwd()
    try {
      const result = await restoreProfile(profile, artifactPath, {
        mode,
        confirmName: body.confirmName,
        ageKeyPath: secrets.getOptional('AGE_KEY_PATH') ?? join(homeDir, 'secrets.d/age.key.txt'),
        homeDir,
      })
      await auditRestore(homeDir, {
        profileId: id,
        runId: body.runId,
        mode,
        operator: 'web-admin',
        result: 'ok',
      })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await auditRestore(homeDir, { profileId: id, runId: body.runId, mode, operator: 'web-admin', result: 'failed', error: message })
      await reply.code(500).send({ error: message })
    }
  })

  /** 还原审计日志（只增不改） */
  app.get('/api/restore-audit', async () => {
    const homeDir = process.env.AUTOBACKUP_HOME ?? process.cwd()
    const auditPath = join(homeDir, 'logs', 'restore-audit.jsonl')
    if (!existsSync(auditPath)) return { entries: [] }
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean)
    return { entries: lines.slice(-100).map((l) => JSON.parse(l) as unknown) }
  })

  // ---- runs ----
  app.get('/api/runs', async (req) => {
    const q = req.query as { profileId?: string; limit?: string }
    const runs = store.listRuns(q.profileId, Math.min(Number(q.limit ?? 50), 200))
    return { runs: runs.map(pickRunPublic) }
  })

  // ---- SSE 事件流（仪表盘实时刷新，designer 方案：SSE 不用 WebSocket）----
  const sseClients = new Set<FastifyReplyLike>()
  app.get('/api/events', async (req, reply) => {
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    raw.write(`event: hello\ndata: connected\n\n`)
    sseClients.add(reply as FastifyReplyLike)
    req.raw.on('close', () => sseClients.delete(reply as FastifyReplyLike))
    // 心跳防超时
    const hb = setInterval(() => raw.write(`: hb\n\n`), 25_000)
    req.raw.on('close', () => clearInterval(hb))
    await new Promise(() => {}) // 保持连接
  })

  /** SSE 广播（run 状态变化时由 pipeline 调用） */
  function broadcast(event: string, data: unknown): void {
    for (const client of sseClients) {
      try {
        client.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      } catch {
        sseClients.delete(client)
      }
    }
  }
  // 供 pipeline 集成（M3 后续：pipeline 事件挂钩）；先导出避免未使用告警
  void broadcast

  // 静态 UI（M3 构建产物）
  const webDist = join(__dirname, '../../web/dist')
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist })
    app.addHook('onSend', async (req, reply, payload) => {
      const path = req.url.split('?')[0] ?? ''
      if (!path.startsWith('/api/') && !path.startsWith('/auth/')) {
        reply.header('Cache-Control', 'no-cache')
      }
      return payload
    })
    app.setNotFoundHandler(async (req, reply) => {
      const path = req.url.split('?')[0] ?? ''
      if (path.startsWith('/api/') || path.startsWith('/auth/')) {
        await reply.code(404).send({ error: 'not found' })
        return
      }
      await reply.sendFile('index.html')
    })
  }

  await app.listen({ port, host: '127.0.0.1' })
  console.log(`[autobackup] Web UI: http://127.0.0.1:${port} (webDist ${existsSync(webDist) ? 'loaded' : 'MISSING — run web build'})`)

  return {
    port,
    auth,
    stop: async () => {
      await app.close()
    },
  }
}

interface FastifyReplyLike {
  raw: { write: (s: string) => void }
}

function pickRunPublic(r: RunRecord): Record<string, unknown> {
  return {
    id: r.id,
    profileId: r.profileId,
    trigger: r.trigger,
    status: r.status,
    stage: r.stage,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    durationMs: r.durationMs,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    encrypted: r.encrypted,
    pushes: r.pushes,
    error: r.error,
  }
}

// Fastify reply cookie 类型（避免引入额外类型包）

