import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlertHub, BarkNotifier, EmailNotifier, emailConfigFromSecrets, normalizeSmtpHost, notifyEventEnabled, NOTIFY_EVENT_PREFS, type EmailConfig } from './notifier.js'
import type { Secrets } from './secrets.js'

/**
 * 告警体系回归（2026-09-12 双通道改造 + 2026-09-18 失败去重，用户拍板改为自然日窗口）。
 * 守护：①懒读配置（UI 保存免重启热生效）②同一故障当天只投递首封，重试失败静默
 * ③跨天重置重新告警；backup_ok 静默且不重置当天已发事实 ④通道故障隔离
 * ⑤未配置通道不分发 ⑥test 事件直接分发不受抑制。
 */

type FetchMock = ReturnType<typeof vi.fn>
let fetchMock: FetchMock

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function fetchUrl(i = 0): string {
  return String(fetchMock.mock.calls[i]?.[0])
}

const okEmailCfg: EmailConfig = { host: 'smtp.qq.com', port: 465, secure: true, user: 'me@qq.com', pass: 'authcode', to: 'me@qq.com' }
const emailCfg = (over: Partial<EmailConfig> = {}): EmailConfig => ({ ...okEmailCfg, ...over })

describe('BarkNotifier（level 由 Hub 传入）', () => {
  it('未配置：不投递返回 false 留痕', async () => {
    const n = new BarkNotifier(() => undefined)
    await expect(n.send('backup_failed', 'x', 'active')).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('懒读生效 + URL 拼接：构造后补配置立即发出；去尾斜杠/编码/group/level', async () => {
    let url: string | undefined = undefined
    const n = new BarkNotifier(() => url, 'server')
    await n.send('backup_failed', 'a', 'active')
    url = 'https://api.day.app/key/'
    await expect(n.send('backup_failed', '❌ p1', 'critical')).resolves.toBe(true)
    expect(fetchUrl(0)).toContain('https://api.day.app/key/%5Bserver%5D%20')
    expect(fetchUrl(0)).toContain('?group=AutoBackup&level=critical')
  })

  it('投递异常/HTTP 非 2xx：false 不抛，lastError 可查', async () => {
    const n = new BarkNotifier(() => 'https://api.day.app/key')
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    await expect(n.send('backup_failed', 'a', 'active')).resolves.toBe(false)
    expect(n.lastError).toContain('network down')
    fetchMock.mockResolvedValueOnce({ ok: false, status: 410 })
    await expect(n.send('backup_failed', 'b', 'active')).resolves.toBe(false)
    expect(n.lastError).toContain('410')
  })

  it('开关关闭：URL 已配置也不参与自动告警（isConfigured false），但手动 send 仍可用', async () => {
    const n = new BarkNotifier(() => 'https://api.day.app/key', 'server', () => false)
    expect(n.isConfigured()).toBe(false)
    await expect(n.send('backup_failed', 'x', 'active')).resolves.toBe(true)
  })
})

describe('AlertHub 分发与失败去重', () => {
  it('同一故障当天只投递首封，重试失败静默；跨天重置重新告警', async () => {
    let fakeNow = new Date('2026-09-18T09:00:00')
    const bark = new BarkNotifier(() => 'https://api.day.app/key')
    const hub = new AlertHub([bark], { now: () => fakeNow })
    await hub.send('backup_failed', '1', 'backup:p1')
    await hub.send('backup_failed', '2', 'backup:p1')
    await hub.send('backup_failed', '3', 'backup:p1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchUrl(0)).toContain('level=active')
    fakeNow = new Date('2026-09-19T00:00:00') // 跨天
    await hub.send('backup_failed', '4', 'backup:p1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchUrl(1)).toContain('level=active')
  })

  it('backup_ok 静默且不重置当天已发事实（当天仍只一封）', async () => {
    let fakeNow = new Date('2026-09-18T09:00:00')
    const bark = new BarkNotifier(() => 'https://api.day.app/key')
    const hub = new AlertHub([bark], { now: () => fakeNow })
    await hub.send('backup_failed', '1', 'backup:p1')
    await hub.send('backup_ok', 'ok', 'backup:p1')
    await hub.send('backup_failed', '2', 'backup:p1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fakeNow = new Date('2026-09-19T00:00:00')
    await hub.send('backup_failed', '3', 'backup:p1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('不同 source 独立去重；普通事件不受抑制', async () => {
    const bark = new BarkNotifier(() => 'https://api.day.app/key')
    const hub = new AlertHub([bark])
    await hub.send('backup_failed', 'a', 'backup:p1')
    await hub.send('backup_failed', 'b', 'backup:p2') // 另一档案首次失败照发
    await hub.send('backup_failed', 'c') // 无 source 聚合到全局键，首封照发
    await hub.send('quota_pruned', '裁剪提示', 'quota:t1:p1')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('test 事件直接分发且不改变失败去重状态', async () => {
    const bark = new BarkNotifier(() => 'https://api.day.app/key')
    const hub = new AlertHub([bark])
    await hub.send('backup_failed', '1', 'backup:p1')
    await hub.send('test', '测试', 'test:ui')
    await hub.send('backup_failed', '2', 'backup:p1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(decodeURIComponent(fetchUrl(1))).toContain('测试')
  })

  it('isEventEnabled 关闭的事件不投递；未登记事件（test）放行', async () => {
    const bark = new BarkNotifier(() => 'https://api.day.app/key')
    const hub = new AlertHub([bark], { isEventEnabled: (e) => e !== 'quota_pruned' })
    await hub.send('quota_pruned', '裁剪提示', 'quota:t1:p1')
    expect(fetchMock).not.toHaveBeenCalled()
    await hub.send('backup_failed', '失败', 'backup:p1')
    await hub.send('test', '测试', 'test:ui')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('notifyEventEnabled：quota_pruned 缺省关（用户拍板），显式 1 开；backup_failed 缺省开', () => {
    const get = (k: string) => ({ NOTIFY_QUOTA_PRUNED: '1', NOTIFY_BACKUP_FAILED: '0' })[k]
    expect(notifyEventEnabled(() => undefined, 'quota_pruned')).toBe(false)
    expect(notifyEventEnabled(get, 'quota_pruned')).toBe(true)
    expect(notifyEventEnabled(() => undefined, 'backup_failed')).toBe(true)
    expect(notifyEventEnabled(get, 'backup_failed')).toBe(false)
    expect(notifyEventEnabled(() => undefined, 'unregistered_event')).toBe(true)
  })

  it('NOTIFY_EVENT_PREFS：四个事件登记齐全，键唯一', () => {
    expect(NOTIFY_EVENT_PREFS.map((p) => p.event)).toEqual([
      'backup_failed',
      'quota_pruned',
      'new_app_added',
      'auto_profile_removed',
    ])
    expect(new Set(NOTIFY_EVENT_PREFS.map((p) => p.key)).size).toBe(4)
  })

  it('未配置通道不分发（结果里不出现）', async () => {
    const hub = new AlertHub([new BarkNotifier(() => undefined)])
    await expect(hub.send('backup_failed', 'x')).resolves.toEqual({})
  })

  it('通道隔离：A 通道抛错，B 通道照常收 level 并完成投递', async () => {
    const boom = {
      name: 'boom',
      isConfigured: () => true,
      send: async () => {
        throw new Error('channel exploded')
      },
    }
    let receivedLevel = ''
    const good = {
      name: 'good',
      isConfigured: () => true,
      send: async (_e: string, _m: string, level: string) => {
        receivedLevel = level
        return true
      },
    }
    const hub = new AlertHub([boom, good])
    const results = await hub.send('backup_failed', 'msg')
    expect(results).toEqual({ boom: false, good: true })
    expect(receivedLevel).toBe('active')
  })
})

describe('EmailNotifier（注入 fake transport）', () => {
  it('配置不全：isConfigured false，send 拒绝且不建连接', async () => {
    const make = vi.fn()
    const n = new EmailNotifier(() => null, 'server', make)
    expect(n.isConfigured()).toBe(false)
    await expect(n.send('backup_failed', 'x', 'active')).resolves.toBe(false)
    expect(make).not.toHaveBeenCalled()
  })

  it('开关关闭：配置完整也不参与自动告警（isConfigured false），但手动 send 仍可用', async () => {
    const make = vi.fn(async (_cfg: EmailConfig) => ({ sendMail: async () => ({}), close: () => {} }))
    const n = new EmailNotifier(() => emailCfg(), 'server', make, () => false)
    expect(n.isConfigured()).toBe(false)
    await expect(n.send('backup_failed', 'x', 'active')).resolves.toBe(true)
    expect(make).toHaveBeenCalledTimes(1)
  })

  it('完整配置：host/port/secure/auth 传给 transport；critical 主题🚨+高优先级头；正文含事件；用完关连接', async () => {
    const sendMail = vi.fn(async (_mail: Record<string, unknown>) => ({}))
    const close = vi.fn()
    const makeTransport = vi.fn(async (_cfg: EmailConfig) => ({ sendMail, close }))
    const n = new EmailNotifier(() => emailCfg(), 'server', makeTransport)
    await expect(n.send('backup_failed', '❌ vaultwarden 备份失败：timeout', 'critical')).resolves.toBe(true)
    const cfg = makeTransport.mock.calls[0]?.[0]
    expect(cfg?.host).toBe('smtp.qq.com')
    expect(cfg?.secure).toBe(true)
    const mail = sendMail.mock.calls[0]?.[0]
    expect(String(mail?.subject)).toContain('🚨')
    expect(String(mail?.to)).toBe('me@qq.com')
    expect(String(mail?.text)).toContain('vaultwarden')
    expect((mail?.headers as Record<string, string>)?.['X-Priority']).toBe('1')
    expect(close).toHaveBeenCalled()
  })

  it('active 级别不加高优先级头', async () => {
    const sendMail = vi.fn(async (_mail: Record<string, unknown>) => ({}))
    const n = new EmailNotifier(() => emailCfg(), 'server', async () => ({ sendMail, close: () => {} }))
    await n.send('test', 'x', 'active')
    const mail = sendMail.mock.calls[0]?.[0]
    expect(mail?.headers).toBeUndefined()
    expect(String(mail?.subject)).not.toContain('🚨')
  })

  it('sendMail/加载抛错：返回 false 不抛出，lastError 留原因', async () => {
    const n = new EmailNotifier(() => emailCfg(), 'server', async () => {
      throw new Error('Auth failed')
    })
    await expect(n.send('test', 'x', 'active')).resolves.toBe(false)
    expect(n.lastError).toContain('Auth failed')
  })
})

describe('normalizeSmtpHost（用户粘贴 http://smtp.qq.com/ 事故固化）', () => {
  it('剥协议前缀/路径/尾斜杠/尾端口', () => {
    expect(normalizeSmtpHost('http://smtp.qq.com/')).toBe('smtp.qq.com')
    expect(normalizeSmtpHost('https://smtp.163.com')).toBe('smtp.163.com')
    expect(normalizeSmtpHost('smtp://smtp.qq.com/mail')).toBe('smtp.qq.com')
    expect(normalizeSmtpHost('smtp.qq.com:465')).toBe('smtp.qq.com')
    expect(normalizeSmtpHost('  smtp.qq.com/  ')).toBe('smtp.qq.com')
  })

  it('裸域名原样保留', () => {
    expect(normalizeSmtpHost('smtp.qq.com')).toBe('smtp.qq.com')
  })

  it('脏 host 经 emailConfigFromSecrets 读取自愈（历史配置免重填）', () => {
    const fake = {
      getOptional: (k: string) =>
        (({ SMTP_HOST: 'http://smtp.qq.com/', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_TO: 't' }) as Record<string, string>)[k] || undefined,
    } as unknown as Secrets
    expect(emailConfigFromSecrets(fake)?.host).toBe('smtp.qq.com')
  })
})

describe('emailConfigFromSecrets', () => {
  const fakeSecrets = (map: Record<string, string>): Secrets =>
    ({
      getOptional: (k: string) => map[k] || undefined,
      has: (k: string) => !!map[k],
    }) as unknown as Secrets

  it('缺任一必填返回 null', () => {
    expect(emailConfigFromSecrets(fakeSecrets({ SMTP_HOST: 'h', SMTP_USER: 'u', MAIL_TO: 't' }))).toBeNull()
  })

  it('465 端口=TLS，其他端口=STARTTLS；端口非法回退 465', () => {
    const full465 = { SMTP_HOST: 'smtp.qq.com', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_TO: 't' }
    expect(emailConfigFromSecrets(fakeSecrets(full465))?.secure).toBe(true)
    const full587 = { ...full465, SMTP_PORT: '587' }
    expect(emailConfigFromSecrets(fakeSecrets(full587))?.secure).toBe(false)
    const junk = { ...full465, SMTP_PORT: 'abc' }
    expect(emailConfigFromSecrets(fakeSecrets(junk))?.port).toBe(465)
  })
})
