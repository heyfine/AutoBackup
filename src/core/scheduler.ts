import type { Store } from '../store/db.js'
import type { AppProfile } from '../types.js'
import type { Pipeline } from './pipeline.js'

/**
 * 调度器：每 30s tick，扫描 enabled 档案的 next_at（存 runs 台账 + apps.scheduleAt 推算）。
 * 全局并发 = 1（1C 机器，评审 D 系列决策）；每档案互斥（跳过本轮）。
 * 错峰：默认批次窗口 03:00-05:00，vaultwarden 类可用 scheduleAt 单独指定。
 */
export class Scheduler {
  private running = false
  private inFlight = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  /** 上次每日批次日期（ISO date），确保每天只跑一轮 */
  private lastBatchDate = ''

  constructor(
    private readonly store: Store,
    private readonly pipeline: Pipeline,
    private readonly getWindow: () => { startMin: number; endMin: number },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), 30_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private nowMinutes(): number {
    const d = new Date()
    return d.getHours() * 60 + d.getMinutes()
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const today = new Date().toISOString().slice(0, 10)
      const win = this.getWindow()
      const nowMin = this.nowMinutes()
      const inWindow = nowMin >= win.startMin && nowMin <= win.endMin

      const profiles = this.store.listProfiles()
      const due: AppProfile[] = []
      for (const p of profiles) {
        if (this.inFlight.has(p.id)) continue // 每档案互斥
        if (p.scheduleAt) {
          // 自定义时刻：HH:mm 精确匹配（错过窗口 5 分钟内补跑）
          const [hh, mm] = p.scheduleAt.split(':').map(Number)
          if (hh === undefined || mm === undefined) continue
          const target = hh * 60 + mm
          if (nowMin >= target && nowMin <= target + 5) due.push(p)
        } else if (inWindow) {
          // 批次窗口内每天一次：查今天该 profile 是否已有 schedule 触发的成功/运行中 run
          const runs = this.store.listRuns(p.id, 10)
          const todayRun = runs.some(
            (r) => r.trigger === 'schedule' && r.startedAt.slice(0, 10) === today && (r.status === 'success' || r.status === 'running'),
          )
          if (!todayRun) due.push(p)
        }
      }

      // 先轻后重排序（评审采纳：config → sqlite → db dump → 大目录）
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

  /** 手动立即备份（绕过窗口与互斥等待，但仍防同档案并发） */
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
