import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BarkNotifier } from './notifier.js'

/**
 * BarkNotifier 回归用例。
 * 重点守护：①懒读 BARK_URL（2026-09-12 修复：构造期快照导致 UI 保存后必须重启才生效）
 * ②连续 3 次失败升级 critical ③test 事件不动失败计数 ④投递失败绝不抛出（不能拖垮备份主流程）。
 */

type FetchMock = ReturnType<typeof vi.fn>
let fetchMock: FetchMock
let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function fetchUrl(i = 0): string {
  return String(fetchMock.mock.calls[i]?.[0])
}

describe('BarkNotifier', () => {
  it('未配置 BARK_URL：不投递，返回 false 并留 console 痕', async () => {
    const n = new BarkNotifier(() => undefined)
    await expect(n.send('backup_failed', 'x')).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[notify:disabled]'))
  })

  it('懒读生效：构造后补配置，下一条通知立即发出（热生效回归）', async () => {
    let url: string | undefined = undefined
    const n = new BarkNotifier(() => url)
    await expect(n.send('backup_failed', 'a')).resolves.toBe(false)
    url = 'https://api.day.app/key123'
    await expect(n.send('backup_failed', 'b')).resolves.toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchUrl(0)).toContain('api.day.app/key123')
  })

  it('URL 拼接：去尾斜杠 / 消息编码 / group 与 level 参数', async () => {
    const n = new BarkNotifier(() => 'https://api.day.app/key/', 'server')
    await n.send('backup_failed', '❌ p1 失败：timeout')
    expect(fetchUrl(0)).toContain('https://api.day.app/key/%5Bserver%5D%20')
    expect(fetchUrl(0)).toContain('?group=AutoBackup&level=active')
  })

  it('连续 3 次 backup_failed 升级 critical；backup_ok 归零', async () => {
    const n = new BarkNotifier(() => 'https://api.day.app/key')
    await n.send('backup_failed', '1')
    await n.send('backup_failed', '2')
    await n.send('backup_failed', '3')
    expect(fetchUrl(2)).toContain('level=critical')
    await n.send('backup_ok', 'ok') // 第 4 次调用（index 3）
    await n.send('backup_failed', '4')
    expect(fetchUrl(4)).toContain('level=active')
  })

  it('test 事件不改变失败计数（发测试通知不能重置升级判定）', async () => {
    const n = new BarkNotifier(() => 'https://api.day.app/key')
    await n.send('backup_failed', '1')
    await n.send('backup_failed', '2')
    await expect(n.send('test', '测试')).resolves.toBe(true)
    await n.send('backup_failed', '3')
    expect(fetchUrl(3)).toContain('level=critical')
  })

  it('投递异常/HTTP 非 2xx：返回 false 不抛出（不影响备份主流程）', async () => {
    const n = new BarkNotifier(() => 'https://api.day.app/key')
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    await expect(n.send('backup_failed', 'a')).resolves.toBe(false)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 410 })
    await expect(n.send('backup_failed', 'b')).resolves.toBe(false)
    expect(errSpy).toHaveBeenCalledTimes(2)
  })
})
