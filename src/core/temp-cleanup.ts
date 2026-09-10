import { readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 临时产物清理（还原预览 preview/、还原工作区 restore-work/、还原前兜底 pre-restore/）。
 * 超过 maxAgeMs 的目录自动删除——「24h 后可删」的承诺由这里兑现。
 * 调用时机：服务启动时 + 每 6 小时一次。
 */
export async function cleanupTempDirs(homeDir: string, maxAgeMs = 24 * 3600 * 1000): Promise<{ removed: string[] }> {
  const removed: string[] = []
  const roots = ['preview', 'restore-work', 'pre-restore']
  const cutoff = Date.now() - maxAgeMs
  for (const root of roots) {
    const dir = join(homeDir, root)
    if (!existsSync(dir)) continue
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      // 目录名约定：<profileId>-<timestamp>
      const m = name.match(/(\d{13})$/)
      if (!m) continue
      const ts = parseInt(m[1] ?? '0', 10)
      if (ts > 0 && ts < cutoff) {
        await rm(join(dir, name), { recursive: true, force: true }).catch(() => {})
        removed.push(`${root}/${name}`)
      }
    }
  }
  return { removed }
}

/** 启动周期清理定时器（6h 间隔），返回 stop 函数 */
export function startTempCleanupTimer(homeDir: string): () => void {
  const tick = () => cleanupTempDirs(homeDir).then(({ removed }) => {
    if (removed.length > 0) console.log(`[autobackup] 清理过期临时目录 ${removed.length} 个: ${removed.join(', ')}`)
  }).catch(() => {})
  tick()
  const t = setInterval(tick, 6 * 3600 * 1000)
  return () => clearInterval(t)
}
