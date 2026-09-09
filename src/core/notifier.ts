/**
 * Bark 通知（失败必告警，成功静默）。
 * BARK_URL 形如 https://api.day.app/yourkey；未配置时降级为 console（开发环境）。
 * 连续失败计数在 Scheduler 层维护，这里负责投递。
 */
export class BarkNotifier {
  private consecutiveFailures = 0

  constructor(
    private readonly barkUrl: string | undefined,
    private readonly source: 'local' | 'server' = 'server',
  ) {}

  /** 事件 → 是否推送（成功静默原则） */
  shouldPush(event: string): boolean {
    return event !== 'backup_recovered' && event !== 'heartbeat_ok'
  }

  async send(event: string, message: string): Promise<void> {
    if (event === 'backup_failed' || event === 'auth_failed') {
      this.consecutiveFailures++
    } else if (event === 'backup_ok') {
      this.consecutiveFailures = 0
    }
    // 连续 3 次失败升级紧急（isLevel=critical，Bark 持续响铃）
    const level = this.consecutiveFailures >= 3 ? 'critical' : 'active'
    const tag = `[${this.source}]`

    if (!this.barkUrl) {
      console.log(`[notify:disabled] ${event} ${message}`)
      return
    }
    try {
      const url = `${this.barkUrl.replace(/\/$/, '')}/${encodeURIComponent(`${tag} ${message}`)}?group=AutoBackup&level=${level}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) {
        console.error(`[notify:failed] Bark HTTP ${res.status}: ${message}`)
      }
    } catch (err) {
      // 通知失败不能影响备份主流程，但必须留痕
      console.error(`[notify:error] ${err instanceof Error ? err.message : String(err)}: ${message}`)
    }
  }
}
