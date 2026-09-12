import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../store/db.js'
import type { AlertHub } from './notifier.js'
import type { DetectedDraft } from '../types.js'
import { scanAndRegister, type AutoDetectDeps } from './auto-detect.js'
import { pathOverlaps } from './detector.js'

/**
 * 自动扫描入档回归（2026-09-12，用户拍板：自动入档但备份开关默认关）。
 * 守护安全线：①创建档案 enabled=false（未确认绝不备份）②绝不覆盖已有档案（含用户编辑）
 * ③僵尸清理仅限 auto_ 前缀+未启用+容器消失 ④用户已开开关的自动档案不删
 * ⑤发现通知可关（关=静默入档，不发通知）。
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

function deps(
  drafts: DetectedDraft[],
  running: string[],
  notifyEnabled = true,
): AutoDetectDeps {
  return {
    detect: async () => ({ drafts, scanned: drafts.length }),
    runningContainers: async () => new Set(running),
    notifyEnabled: () => notifyEnabled,
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

describe('pathOverlaps（目录/文件互为前缀的去重口径）', () => {
  it('db 文件在既有目录内=重叠；不同目录=不重叠；同名目录带斜杠=重叠', () => {
    expect(pathOverlaps('/opt/vaultwarden/data/db.sqlite3', ['/opt/vaultwarden/data'])).toBe(true)
    expect(pathOverlaps('/opt/vaultwarden/data', ['/opt/vaultwarden/data/db.sqlite3'])).toBe(true)
    expect(pathOverlaps('/opt/vaultwarden/data2', ['/opt/vaultwarden/data'])).toBe(false)
    expect(pathOverlaps('/opt/data/', ['/opt/data'])).toBe(true)
  })
})

describe('scanAndRegister', () => {
  it('新应用 → 入档 enabled=false + 通知一次', async () => {
    const out = await scanAndRegister(store, hub, deps([draft('app-a'), draft('app-b')], ['app-a', 'app-b']))
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
    const d = deps([draft('app-a')], ['app-a'])
    await scanAndRegister(store, hub, d)
    const p = store.getProfile('auto_app-a')!
    store.upsertProfile({ ...p, name: '我的心爱服务', enabled: true })
    hubSend.mockClear()
    const out = await scanAndRegister(store, hub, d)
    expect(out.added).toHaveLength(0)
    const after = store.getProfile('auto_app-a')
    expect(after?.name).toBe('我的心爱服务')
    expect(after?.enabled).toBe(true)
    expect(hubSend).not.toHaveBeenCalled() // 无变化不打扰
  })

  it('僵尸清理：auto_ 档案 + 未启用 + 容器消失 → 删除并通知', async () => {
    await scanAndRegister(store, hub, deps([draft('gone-app')], ['gone-app']))
    const out = await scanAndRegister(store, hub, deps([], []))
    expect(out.removed).toEqual(['gone-app 数据'])
    expect(store.getProfile('auto_gone-app')).toBeFalsy()
    expect(hubSend.mock.calls.some((c) => c[0] === 'auto_profile_removed')).toBe(true)
  })

  it('用户已开启的自动档案：容器消失也不删（失败告警由流水线负责）', async () => {
    await scanAndRegister(store, hub, deps([draft('app-a')], ['app-a']))
    const p = store.getProfile('auto_app-a')!
    store.upsertProfile({ ...p, enabled: true })
    const out = await scanAndRegister(store, hub, deps([], []))
    expect(out.removed).toHaveLength(0)
    expect(store.getProfile('auto_app-a')).toBeTruthy()
  })

  it('v2 合并档案（信息在 parts[]）的容器与路径必须计入覆盖——VPS 首轮误报事故回归', async () => {
    store.upsertProfile({
      id: 'p_vault_merged',
      name: 'Vaultwarden 合并档',
      kind: 'sqlite',
      paths: [],
      containers: [],
      parts: [
        { kind: 'sqlite', label: 'db', container: 'vaultwarden', dbPath: '/opt/vaultwarden/data/db.sqlite3', paths: [] },
        { kind: 'config', label: 'cfg', paths: ['/opt/vaultwarden/compose.yaml'] },
      ],
      encrypt: true,
      consistency: 'consistent',
      schedule: { mode: 'daily', at: '03:00' },
      targetIds: [],
      keep: 7,
      enabled: true,
      isDraft: false,
    })
    let seenContainers: string[] = []
    let seenPaths: string[] = []
    await scanAndRegister(store, hub, {
      detect: async (cov, paths) => {
        seenContainers = cov
        seenPaths = paths
        return { drafts: [], scanned: 0 }
      },
      runningContainers: async () => new Set(['vaultwarden']),
      notifyEnabled: () => true,
    })
    expect(seenContainers).toContain('vaultwarden') // parts.container 计入
    expect(seenPaths).toContain('/opt/vaultwarden/data/db.sqlite3') // parts.dbPath 计入
    expect(store.getProfile('auto_vaultwarden')).toBeFalsy()
  })

  it('通知开关关闭：照常静默入档，不发任何通知', async () => {
    const out = await scanAndRegister(store, hub, deps([draft('quiet-app')], ['quiet-app'], false))
    expect(out.added).toHaveLength(1) // 入档不受开关影响
    expect(store.getProfile('auto_quiet-app')?.enabled).toBe(false)
    expect(hubSend).not.toHaveBeenCalled() // 但通知不发
    // 僵尸清理同理静默
    const out2 = await scanAndRegister(store, hub, deps([], [], false))
    expect(out2.removed).toEqual(['quiet-app 数据'])
    expect(hubSend).not.toHaveBeenCalled()
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
    const out = await scanAndRegister(store, hub, deps([], []))
    expect(out.removed).toHaveLength(0)
    expect(store.getProfile('p_manual')).toBeTruthy()
  })
})
