import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AlertHub, BarkNotifier, EmailNotifier, emailConfigFromSecrets, type EmailConfig } from './notifier.js'
import type { Secrets } from './secrets.js'

/**
 * 告警体系回归（2026-09-12 双通道改造）。
 * 守护：①懒读配置（UI 保存免重启热生效）②连续 3 次失败升级 critical（计数在 Hub，统一分发）
 * ③通道故障隔离（一通道炸不影响另一通道与备份主流程）④未配置通道不分发 ⑤test 事件不动计数。
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
})

describe('AlertHub 计数与分发', () => {
  it('连续 3 次失败升级 critical；backup_ok 归零；计数在 Hub 统一', async () => {
    const bark = new BarkNotifier(() => 'https://api.day.app/key')
    const hub = new AlertHub([bark])
    await hub.send('backup_failed', '1')
    await hub.send('backup_failed', '2')
    await hub.send('backup_failed', '3')
    expect(fetchUrl(2)).toContain('level=critical')
    await hub.send('backup_ok', 'ok')
    await hub.send('backup_failed', '4')
    expect(fetchUrl(4)).toContain('level=active')
  })

  it('test 事件不影响失败计数', async () => {
    const bark = new BarkNotifier(() => 'https://api.day.app/key')
    const hub = new AlertHub([bark])
    await hub.send('backup_failed', '1')
    await hub.send('backup_failed', '2')
    await hub.send('test', '测试')
    await hub.send('backup_failed', '3')
    expect(fetchUrl(3)).toContain('level=critical')
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
