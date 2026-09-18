import type { Secrets } from './secrets.js'

/**
 * 告警体系：AlertHub 统一分发（失败必告警，成功静默）。
 * 通道：Bark(iOS 推送) + Email(SMTP)，各自独立配置、独立成败、互不阻塞。
 * 连续失败计数上收 Hub（防各通道分别计数漂移），level 一次计算分发全部通道。
 * 通道一律懒读配置（闭包读 Secrets）——UI 保存后免重启热生效。
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

/** 同一持续故障在窗口内只投递一封；窗口到期仍未恢复则 critical 重申（防失败风暴轰炸） */
const RE_ALERT_INTERVAL_MS = 2 * 3600 * 1000

interface AlertState {
  failing: boolean
  lastAlertedAt: number
}

export class AlertHub {
  private readonly states = new Map<string, AlertState>()
  readonly channels: readonly AlertChannel[]

  constructor(
    channels: AlertChannel[],
    private readonly opts: { reAlertAfterMs?: number } = {},
  ) {
    this.channels = channels
  }

  channel(name: string): AlertChannel | undefined {
    return this.channels.find((c) => c.name === name)
  }

  /**
   * 分发一个告警事件，返回各已配置通道的投递结果（未配置通道不出现在结果里）。
   * source 是故障归属键（如 profileId）：同键持续失败在去重窗口内静默，超窗重申 critical；
   * backup_ok 只复位不投递（成功静默）；普通事件直接分发，不受去重影响。
   * 签名兼容 pipeline 的 NotifySink（调用方 await 后忽略返回值）。
   */
  async send(event: string, message: string, source?: string): Promise<Record<string, boolean>> {
    if (event === 'backup_ok') {
      this.states.set(source ?? event, { failing: false, lastAlertedAt: 0 })
      return {}
    }
    if (event !== 'backup_failed' && event !== 'auth_failed') {
      return this.dispatch(event, message, 'active')
    }
    const key = source ?? event
    const now = Date.now()
    const st = this.states.get(key) ?? { failing: false, lastAlertedAt: 0 }
    const reAlertAfterMs = this.opts.reAlertAfterMs ?? RE_ALERT_INTERVAL_MS
    if (st.failing && now - st.lastAlertedAt < reAlertAfterMs) {
      return {} // 同故障仍处于去重窗口：静默，不打扰
    }
    const level: AlertLevel = st.failing ? 'critical' : 'active'
    this.states.set(key, { failing: true, lastAlertedAt: now })
    return this.dispatch(event, message, level)
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
  ) {}

  isConfigured(): boolean {
    return !!this.getBarkUrl()
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
  ) {}

  isConfigured(): boolean {
    return this.getConfig() !== null
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
