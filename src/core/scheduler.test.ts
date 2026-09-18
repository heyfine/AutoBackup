import { describe, expect, it } from 'vitest'
import { Scheduler } from './scheduler.js'
import type { Store } from '../store/db.js'
import type { Pipeline } from './pipeline.js'
import type { AppProfile, RunRecord } from '../types.js'

/**
 * 调度器回归（2026-09-18 失败重试改造）。
 * 守护：①最近一次 run 失败 → 固定 6h 后重试（不再随 30s tick 风暴）
 * ②成功/无记录走原频率模型（interval/daily）③6h 未到不 due，到点可执行。
 */

const FAILURE_RETRY_MS = 6 * 3600 * 1000

function makeProfile(over: Partial<AppProfile> = {}): AppProfile {
  return {
    id: 'p1',
    name: 'p1',
    kind: 'config',
    parts: [],
    paths: [],
    containers: [],
    encrypt: false,
    consistency: 'best_effort',
    schedule: { mode: 'interval', hours: 6 },
    targetIds: [],
    keep: 3,
    enabled: true,
    isDraft: false,
    ...over,
  }
}

function makeRun(over: Partial<RunRecord>): RunRecord {
  return {
    id: 'r1',
    profileId: 'p1',
    trigger: 'schedule',
    status: 'failed',
    stage: 'done',
    startedAt: '2026-09-18T00:00:00.000Z',
    encrypted: false,
    pushes: [],
    ...over,
  }
}

function makeScheduler(runs: RunRecord[]): Scheduler {
  const store = { listRuns: () => runs } as unknown as Store
  return new Scheduler(store, {} as Pipeline)
}

describe('Scheduler.nextRunAt（失败重试 6h）', () => {
  it('最近 run 失败：下次 = 失败结束时刻 + 6h（与档案频率无关）', () => {
    const finishedAt = new Date('2026-09-18T00:05:00.000Z')
    const s = makeScheduler([
      makeRun({ status: 'failed', startedAt: '2026-09-18T00:00:00.000Z', finishedAt: finishedAt.toISOString() }),
    ])
    expect(s.nextRunAt(makeProfile(), 0)).toBe(finishedAt.getTime() + FAILURE_RETRY_MS)
  })

  it('失败 run 无 finishedAt：退回用 startedAt 起算', () => {
    const startedAt = new Date('2026-09-18T00:00:00.000Z')
    const s = makeScheduler([makeRun({ status: 'failed', startedAt: startedAt.toISOString(), finishedAt: undefined })])
    expect(s.nextRunAt(makeProfile(), 0)).toBe(startedAt.getTime() + FAILURE_RETRY_MS)
  })

  it('6h 窗口内不 due，到点后可执行', () => {
    const finishedAt = new Date('2026-09-18T00:05:00.000Z').getTime()
    const s = makeScheduler([
      makeRun({ status: 'failed', finishedAt: new Date(finishedAt).toISOString() }),
    ])
    const oneHourLater = finishedAt + 3600 * 1000
    expect(s.nextRunAt(makeProfile(), oneHourLater)).toBeGreaterThan(oneHourLater)
    const dueAt = finishedAt + FAILURE_RETRY_MS
    expect(s.nextRunAt(makeProfile(), dueAt)).toBeLessThanOrEqual(dueAt)
  })

  it('最近 run 成功（interval）：按 lastRunAt + interval 推算', () => {
    const lastRunAt = '2026-09-18T00:00:00.000Z'
    const s = makeScheduler([
      makeRun({ status: 'success', startedAt: lastRunAt, finishedAt: lastRunAt }),
    ])
    const p = makeProfile({ schedule: { mode: 'interval', hours: 6 }, lastRunAt })
    expect(s.nextRunAt(p, new Date('2026-09-19T00:00:00.000Z').getTime())).toBe(
      new Date(lastRunAt).getTime() + 6 * 3600 * 1000,
    )
  })

  it('最近 run 成功（daily）：已过时刻且 last 在其后 → 明天同一时刻', () => {
    const s = makeScheduler([makeRun({ status: 'success' })])
    const p = makeProfile({
      schedule: { mode: 'daily', at: '03:30' },
      lastRunAt: new Date(2026, 8, 18, 3, 35, 0).toISOString(),
    })
    const now = new Date(2026, 8, 18, 10, 0, 0).getTime()
    const expected = new Date(2026, 8, 19, 3, 30, 0).getTime()
    expect(s.nextRunAt(p, now)).toBe(expected)
  })

  it('无任何 run（interval）：立即首跑', () => {
    const s = makeScheduler([])
    expect(s.nextRunAt(makeProfile(), 0)).toBe(0)
  })
})
