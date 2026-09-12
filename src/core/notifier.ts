/**
 * Bark 通知（失败必告警，成功静默）。
 * BARK_URL 形如 https://api.day.app/yourkey；未配置时降级为 console（开发环境）。
 * 连续失败计数在本类维护；构造传入 getter 懒读 secrets——UI 保存 BARK_URL 后免重启即生效。
 */
export class BarkNotifier {
  private consecutiveFailures = 0

  constructor(
    private readonly getBarkUrl: () => string | undefined,
    private readonly source: 'local' | 'server' = 'server',
  ) {}

  /** 事件 → 是否推送（成功静默原则） */
  shouldPush(event: string): boolean {
    return event !== 'backup_recovered' && event !== 'heartbeat_ok'
  }

  /** 投递一条通知；返回是否成功送达 Bark（未配置或 HTTP 失败/异常均为 false，绝不抛出） */
  async send(event: string, message: string): Promise<boolean> {
    if (event === 'backup_failed' || event === 'auth_failed') {
      this.consecutiveFailures++
    } else if (event === 'backup_ok') {
      this.consecutiveFailures = 0
    }
    // 连续 3 次失败升级紧急（isLevel=critical，Bark 持续响铃）；test 事件不影响计数
    const level = this.consecutiveFailures >= 3 ? 'critical' : 'active'
    const tag = `[${this.source}]`

    const barkUrl = this.getBarkUrl()
    if (!barkUrl) {
      console.log(`[notify:disabled] ${event} ${message}`)
      return false
    }
    try {
      const url = `${barkUrl.replace(/\/$/, '')}/${encodeURIComponent(`${tag} ${message}`)}?group=AutoBackup&level=${level}`
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) {
        console.error(`[notify:failed] Bark HTTP ${res.status}: ${message}`)
        return false
      }
      return true
    } catch (err) {
      // 通知失败不能影响备份主流程，但必须留痕
      console.error(`[notify:error] ${err instanceof Error ? err.message : String(err)}: ${message}`)
      return false
    }
  }
}
