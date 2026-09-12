import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../store/db.js'
import type { AlertHub } from './notifier.js'
import type { DetectedDraft } from '../types.js'
import { scanAndRegister } from './auto-detect.js'

/**
 * 自动扫描入档回归（2026-09-12，用户拍板：自动入档但备份开关默认关）。
 * 守护安全线：①创建档案 enabled=false（未确认绝不备份）②绝不覆盖已有档案（含用户编辑）
 * ③僵尸清理仅限 auto_ 前缀+未启用+容器消失 ④用户已开开关的自动档案不删。
 */

let home = ''
let store: Store
const hubSend = vi.fn(async (_event: string, _message: string) => ({}) as Record<string, boolean>)
const hub = { send: hubSend } as unknown as AlertHub

function draft(container: string, over: Partial<DetectedDraft> = {}): DetectedDraft {
  return {
    containerName: container,
    image: 'some/image:latest',
    mounts: [],
    confidence: 'high',
    suggestedProfile: {
      name: `${container} 数据`,
      kind: 'directory',
      paths: [`/opt/${container}`],
      containers: [container],
      encrypt: false,
      consistency: 'best_effort',
    },
    ...over,
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ab-ad-'))
  store = new Store(join(home, 'test.db'))
  hubSend.mockClear()
})

afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

describe('scanAndRegister', () => {
  it('新应用 → 入档 enabled=false + 通知一次', async () => {
    const out = await scanAndRegister(store, hub, {
      detect: async () => ({ drafts: [draft('app-a'), draft('app-b')], scanned: 2 }),
      runningContainers: async () => new Set(['app-a', 'app-b']),
    })
    expect(out.added).toHaveLength(2)
    const a = store.getProfile('auto_app-a')
    expect(a).toBeTruthy()
    expect(a?.enabled).toBe(false) // ★ 安全线：开关默认关
    expect(a?.isDraft).toBe(false)
    expect(a?.containers).toEqual(['app-a'])
    expect(a?.schedule).toEqual({ mode: 'daily', at: '03:00' })
    expect(hubSend).toHaveBeenCalledTimes(1) // 汇总通知一条而非逐条轰炸
    expect(hubSend.mock.calls[0]?.[0]).toBe('new_app_added')
  })

  it('已存在档案绝不覆盖（用户改过名字/开过开关，重扫不动）', async () => {
    const deps = {
      detect: async () => ({ drafts: [draft('app-a')], scanned: 1 }),
      runningContainers: async () => new Set(['app-a']),
    }
    await scanAndRegister(store, hub, deps)
    // 模拟用户编辑并开启
    const p = store.getProfile('auto_app-a')!
    store.upsertProfile({ ...p, name: '我的心爱服务', enabled: true })
    hubSend.mockClear()
    const out = await scanAndRegister(store, hub, deps)
    expect(out.added).toHaveLength(0)
    const after = store.getProfile('auto_app-a')
    expect(after?.name).toBe('我的心爱服务')
    expect(after?.enabled).toBe(true)
    expect(hubSend).not.toHaveBeenCalled() // 无变化不打扰
  })

  it('僵尸清理：auto_ 档案 + 未启用 + 容器消失 → 删除并通知', async () => {
    await scanAndRegister(store, hub, {
      detect: async () => ({ drafts: [draft('gone-app')], scanned: 1 }),
      runningContainers: async () => new Set(['gone-app']),
    })
    const out = await scanAndRegister(store, hub, {
      detect: async () => ({ drafts: [], scanned: 0 }),
      runningContainers: async () => new Set(), // 容器已消失
    })
    expect(out.removed).toEqual(['gone-app 数据']) // removed 记录档案名
    expect(store.getProfile('auto_gone-app')).toBeFalsy()
    expect(hubSend.mock.calls.some((c) => c[0] === 'auto_profile_removed')).toBe(true)
  })

  it('用户已开启的自动档案：容器消失也不删（失败告警由流水线负责）', async () => {
    await scanAndRegister(store, hub, {
      detect: async () => ({ drafts: [draft('app-a')], scanned: 1 }),
      runningContainers: async () => new Set(['app-a']),
    })
    const p = store.getProfile('auto_app-a')!
    store.upsertProfile({ ...p, enabled: true })
    const out = await scanAndRegister(store, hub, {
      detect: async () => ({ drafts: [], scanned: 0 }),
      runningContainers: async () => new Set(),
    })
    expect(out.removed).toHaveLength(0)
    expect(store.getProfile('auto_app-a')).toBeTruthy()
  })

  it('手动档案（非 auto_ 前缀）永不被清理逻辑触碰', async () => {
    store.upsertProfile({
      id: 'p_manual',
      name: '手工目录',
      kind: 'directory',
      paths: ['/opt/x'],
      containers: ['x'],
      encrypt: false,
      consistency: 'best_effort',
      schedule: { mode: 'daily', at: '03:00' },
      targetIds: [],
      keep: 7,
      enabled: false,
      isDraft: false,
    })
    const out = await scanAndRegister(store, hub, {
      detect: async () => ({ drafts: [], scanned: 0 }),
      runningContainers: async () => new Set(),
    })
    expect(out.removed).toHaveLength(0)
    expect(store.getProfile('p_manual')).toBeTruthy()
  })
})
