import type { Store } from '../store/db.js'
import type { AppProfile, ScheduleSpec } from '../types.js'
import type { Pipeline } from './pipeline.js'

/** 失败重试间隔（2026-09-18 用户拍板）：最近一次失败后固定 6h 再试 */
const FAILURE_RETRY_MS = 6 * 3600 * 1000

/**
 * 调度器：每 30s tick。
 * 频率模型（产品化，用户确认）：
 *  - daily: 每天 HH:mm 执行（错过窗口 5 分钟内补跑）
 *  - interval: 每隔 N 小时执行（基于 lastRunAt 推算）
 * 失败重试（2026-09-18 用户拍板）：最近一次 run 失败后，固定 6 小时后重试，
 * 不再随 30s tick 风暴重跑；手动「立即备份」不受此限制。
 * 档案可绑定指定目标（targetIds 空=全部启用目标）；keep 为档案级保留份数。
 * 全局并发 = 1；每档案互斥。
 */
export class Scheduler {
  private running = false
  private inFlight = new Set<string>()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly store: Store,
    private readonly pipeline: Pipeline,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 30_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** 推算某档案下次应执行时刻（ms）； overdue = now >= next */
  nextRunAt(p: AppProfile, now = Date.now()): number {
    const lastRun = this.store.listRuns(p.id, 1)[0]
    if (lastRun?.status === 'failed') {
      // 失败重试固定 6h：从失败结束时刻起算，无 finishedAt 时退回开始时刻
      const failedAt = lastRun.finishedAt ? new Date(lastRun.finishedAt).getTime() : new Date(lastRun.startedAt).getTime()
      return failedAt + FAILURE_RETRY_MS
    }
    const last = p.lastRunAt ? new Date(p.lastRunAt).getTime() : 0
    const s: ScheduleSpec = p.schedule
    if (s.mode === 'interval') {
      const intervalMs = Math.max(1, Math.min(168, s.hours)) * 3600 * 1000
      // 无记录 → 立即；有记录 → last + interval
      return last === 0 ? 0 : last + intervalMs
    }
    // daily "HH:mm"：今天的 at 时刻；若已过且 last 在其后，算明天
    const [hh, mm] = s.at.split(':').map(Number)
    const d = new Date(now)
    d.setHours(hh ?? 3, mm ?? 0, 0, 0)
    let todayAt = d.getTime()
    if (todayAt <= now && last >= todayAt) {
      todayAt += 24 * 3600 * 1000
    }
    return todayAt
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const now = Date.now()
      const profiles = this.store.listProfiles()
      const due: AppProfile[] = []
      for (const p of profiles) {
        if (this.inFlight.has(p.id)) continue
        const next = this.nextRunAt(p, now)
        if (now >= next && now - next < 6 * 3600 * 1000) {
          // 到点执行；错过超过 6 小时的（如服务器停机数日）跳过本轮，防重启风暴——下轮 lastRunAt 更新后恢复
          due.push(p)
        } else if (next === 0) {
          due.push(p) // interval 无记录 → 立即首跑
        }
      }

      // 先轻后重（评审采纳：config → sqlite → db dump → 大目录）
      const weight: Record<string, number> = { config: 0, sqlite: 1, mariadb: 2, postgres: 2, directory: 3 }
      due.sort((a, b) => (weight[a.kind] ?? 9) - (weight[b.kind] ?? 9))

      for (const p of due) {
        if (this.inFlight.has(p.id)) continue
        this.inFlight.add(p.id)
        try {
          await this.pipeline.runProfile(p, 'schedule')
        } finally {
          this.inFlight.delete(p.id)
        }
      }
    } finally {
      this.running = false
    }
  }

  /** 手动立即备份（绕过频率，但仍防同档案并发） */
  async runNow(profileId: string): Promise<unknown> {
    const p = this.store.getProfile(profileId)
    if (!p) throw new Error(`profile not found: ${profileId}`)
    if (this.inFlight.has(profileId)) throw new Error(`profile ${profileId} is already running`)
    this.inFlight.add(profileId)
    try {
      return await this.pipeline.runProfile(p, 'manual')
    } finally {
      this.inFlight.delete(profileId)
    }
  }
}
