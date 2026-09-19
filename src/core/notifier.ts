import type { Secrets } from './secrets.js'

/**
 * 告警体系：AlertHub 统一分发（失败必告警，成功静默）。
 * 通道：Bark(iOS 推送) + Email(SMTP)，各自独立配置、独立成败、互不阻塞。
 * 失败通知按 source 键 + 自然日去重：同一故障当天只投递首封，重试失败当天静默；
 * 跨天后再次失败重新告警。通道一律懒读配置（闭包读 Secrets）——UI 保存后免重启热生效。
 */

export type AlertLevel = 'active' | 'critical'

export interface AlertChannel {
  readonly name: string
  isConfigured(): boolean
  /** 投递一条；返回是否成功，绝不抛出（内部消化故障） */
  send(event: string, message: string, level: AlertLevel): Promise<boolean>
  /** 最近一次投递失败原因（UI 测试按钮展示用） */
  lastError?: string
}

/** 本地自然日键（YYYY-MM-DD），失败去重的窗口边界 */
function localDayKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 用户可开关的通知事件（UI「通知偏好」卡与 secrets 键的唯一登记处） */
export interface NotifyEventPref {
  event: string
  /** secrets 键：'0'=关，'1'=开，缺省=defaultOn */
  key: string
  defaultOn: boolean
}

export const NOTIFY_EVENT_PREFS: readonly NotifyEventPref[] = [
  { event: 'backup_failed', key: 'NOTIFY_BACKUP_FAILED', defaultOn: true },
  // 用户拍板 2026-09-19：裁剪删除旧备份属常规运维动作，默认不打扰
  { event: 'quota_pruned', key: 'NOTIFY_QUOTA_PRUNED', defaultOn: false },
  { event: 'new_app_added', key: 'NOTIFY_NEW_APP', defaultOn: true },
  { event: 'auto_profile_removed', key: 'NOTIFY_AUTO_REMOVED', defaultOn: true },
]

/** 读单个事件开关：secrets 缺省走 defaultOn；未登记的事件一律放行（如 test） */
export function notifyEventEnabled(getOptional: (key: string) => string | undefined, event: string): boolean {
  const pref = NOTIFY_EVENT_PREFS.find((p) => p.event === event)
  if (!pref) return true
  const v = getOptional(pref.key)
  if (v === '0') return false
  if (v === '1') return true
  return pref.defaultOn
}

export class AlertHub {
  /** source → 最近一次发出失败通知的自然日（当天已发过则不再发） */
  private readonly lastAlertedDay = new Map<string, string>()
  readonly channels: readonly AlertChannel[]

  constructor(
    channels: AlertChannel[],
    private readonly opts: { now?: () => Date; isEventEnabled?: (event: string) => boolean } = {},
  ) {
    this.channels = channels
  }

  channel(name: string): AlertChannel | undefined {
    return this.channels.find((c) => c.name === name)
  }

  /**
   * 分发一个告警事件，返回各已配置通道的投递结果（未配置通道不出现在结果里）。
   * isEventEnabled：用户级通知偏好（按事件开关，UI「通知偏好」卡控制）；
   * source 是故障归属键（如 profileId）：同一 source 每个自然日只投递首封失败通知，
   * 当天重试失败全部静默，跨天重置；backup_ok 只静默复位（成功不打扰）。
   * 签名兼容 pipeline 的 NotifySink（调用方 await 后忽略返回值）。
   */
  async send(event: string, message: string, source?: string): Promise<Record<string, boolean>> {
    if (event === 'backup_ok') {
      return {} // 成功静默
    }
    if (this.opts.isEventEnabled && !this.opts.isEventEnabled(event)) {
      return {} // 用户关闭了该类通知
    }
    if (event !== 'backup_failed' && event !== 'auth_failed') {
      return this.dispatch(event, message, 'active')
    }
    const key = source ?? event
    const today = localDayKey((this.opts.now ?? (() => new Date()))())
    if (this.lastAlertedDay.get(key) === today) {
      return {} // 当天已告警过该故障：重试失败不再打扰
    }
    this.lastAlertedDay.set(key, today)
    return this.dispatch(event, message, 'active')
  }

  private async dispatch(event: string, message: string, level: AlertLevel): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {}
    for (const ch of this.channels) {
      if (!ch.isConfigured()) continue
      try {
        results[ch.name] = await ch.send(event, message, level)
      } catch (err) {
        // 通道契约是自行消化故障；这层 catch 是最后的分发隔离保险
        console.error(`[notify:${ch.name}:error] ${err instanceof Error ? err.message : String(err)}: ${message}`)
        results[ch.name] = false
      }
    }
    return results
  }
}

/** Bark 推送。BARK_URL 形如 https://api.day.app/yourkey */
export class BarkNotifier implements AlertChannel {
  readonly name = 'bark'
  lastError = ''

  constructor(
    private readonly getBarkUrl: () => string | undefined,
    private readonly source: 'local' | 'server' = 'server',
    /** 用户开关：false = 保留配置但不参与自动告警（测试按钮仍可手动发） */
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  isConfigured(): boolean {
    return this.isEnabled() && !!this.getBarkUrl()
  }

  async send(event: string, message: string, level: AlertLevel): Promise<boolean> {
    this.lastError = ''
    const barkUrl = this.getBarkUrl()
    if (!barkUrl) {
      console.log(`[notify:disabled] ${event} ${message}`)
      return false
    }
    try {
      const url = `${barkUrl.replace(/\/$/, '')}/${encodeURIComponent(`[${this.source}] ${message}`)}?group=AutoBackup&level=${level}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) {
        this.lastError = `Bark HTTP ${res.status}`
        console.error(`[notify:failed] ${this.lastError}: ${message}`)
        return false
      }
      return true
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      console.error(`[notify:error] ${this.lastError}: ${message}`)
      return false
    }
  }
}

export interface EmailConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  to: string
}

/**
 * SMTP host 输入归一化：用户总会粘贴成 http://smtp.qq.com/ 这类网址形态，
 * 而 nodemailer 要的是裸主机名——剥协议前缀、路径、尾部斜杠。
 * 保存与读取两侧都过一遍（读取侧让历史脏数据自愈）。
 */
export function normalizeSmtpHost(raw: string): string {
  let h = raw.trim()
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // http:// smtp:// ssl:// 等协议前缀
  h = h.replace(/\/.*$/, '') // 路径与尾斜杠
  h = h.replace(/:\d+$/, '') // 尾部端口（端口请填端口字段）
  return h
}

/** 从 Secrets 组装邮箱配置（懒读，配置不全返回 null）；465=SSL，其余按 STARTTLS */
export function emailConfigFromSecrets(secrets: Secrets): EmailConfig | null {
  const host = normalizeSmtpHost(secrets.getOptional('SMTP_HOST') ?? '')
  const user = secrets.getOptional('SMTP_USER')
  const pass = secrets.getOptional('SMTP_PASS')
  const to = secrets.getOptional('MAIL_TO')
  if (!host || !user || !pass || !to) return null
  const port = Number(secrets.getOptional('SMTP_PORT') ?? '465') || 465
  return { host, port, secure: port === 465, user, pass, to }
}

/** 邮件投递抽象：测试注入 fake，生产走 nodemailer 动态加载（依赖缺失只降级邮件通道） */
export type EmailTransport = { sendMail(mail: Record<string, unknown>): Promise<unknown>; close(): void }
export type EmailTransportMaker = (cfg: EmailConfig) => Promise<EmailTransport>

const nodemailerTransport: EmailTransportMaker = async (cfg) => {
  const nodemailer = await import('nodemailer')
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  })
}

/** 邮件通道：每次发送建独立 transport 用完即关（告警频率极低，不养长连接） */
export class EmailNotifier implements AlertChannel {
  readonly name = 'email'
  lastError = ''

  constructor(
    private readonly getConfig: () => EmailConfig | null,
    private readonly source: 'local' | 'server' = 'server',
    private readonly makeTransport: EmailTransportMaker = nodemailerTransport,
    /** 用户开关：false = 保留配置但不参与自动告警（测试按钮仍可手动发） */
    private readonly isEnabled: () => boolean = () => true,
  ) {}

  isConfigured(): boolean {
    return this.isEnabled() && this.getConfig() !== null
  }

  async send(event: string, message: string, level: AlertLevel): Promise<boolean> {
    this.lastError = ''
    const cfg = this.getConfig()
    if (!cfg) {
      console.log(`[notify:email:disabled] ${event} ${message}`)
      return false
    }
    try {
      const transport = await this.makeTransport(cfg)
      try {
        await transport.sendMail({
          from: `AutoBackup <${cfg.user}>`,
          to: cfg.to,
          subject: level === 'critical' ? `🚨 ${message}` : message,
          text: [
            message,
            '',
            `时间：${new Date().toISOString()}`,
            `来源：${this.source}`,
            `级别：${level}`,
            '',
            '—— AutoBackup 自动告警，请勿回复',
          ].join('\n'),
          ...(level === 'critical'
            ? { headers: { 'X-Priority': '1', 'X-MSMail-Priority': 'High', Importance: 'high' } }
            : {}),
        })
        return true
      } finally {
        transport.close()
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      console.error(`[notify:email:error] ${this.lastError}: ${message}`)
      return false
    }
  }
}
