import type { Store } from '../store/db.js'
import type { AppProfile } from '../types.js'
import type { AlertHub } from './notifier.js'
import { detectContainers, listRunningContainers, type DetectResult } from './detector.js'

/**
 * 自动扫描新应用 → 自动入档（用户拍板 2026-09-12：不走草稿确认流）。
 * 安全线（硬规则 #1）：创建的档案一律 enabled=false——永不自动备份，
 * 用户在 UI 核对内容后亲手打开开关，开启动作本身就是确认。
 * 约定：本模块创建的档案 id 恒为 auto_<容器名>，用户手建档案绝不受触碰（不覆盖、不清理）。
 */

export const AUTO_PREFIX = 'auto_'

export interface AutoDetectDeps {
  detect: (coveredContainers: string[], existingPaths: string[]) => Promise<DetectResult>
  runningContainers: () => Promise<Set<string>>
}

const liveDeps: AutoDetectDeps = {
  detect: detectContainers,
  runningContainers: listRunningContainers,
}

export interface ScanOutcome {
  added: string[]
  removed: string[]
}

/**
 * 既有档案的「覆盖口径」：v2 合并档案的容器/路径在 parts[] 里，顶层字段是旧格式兼容位
 * ——两侧都必须计入，否则合并过的档案会被视作未覆盖而产生重复档案（2026-09-12 VPS 首轮实扫事故）。
 */
export function coveredContainersOf(profiles: AppProfile[]): string[] {
  return profiles.flatMap((p) => [
    ...(p.containers ?? []),
    ...(p.parts ?? []).map((x) => x.container).filter((c): c is string => !!c),
  ])
}

export function coveredPathsOf(profiles: AppProfile[]): string[] {
  return profiles.flatMap((p) => [
    ...(p.paths ?? []),
    ...(p.dbPath ? [p.dbPath] : []),
    ...(p.parts ?? []).flatMap((x) => x.paths ?? []),
    ...(p.parts ?? []).map((x) => x.dbPath).filter((d): d is string => !!d),
  ])
}

function draftToProfile(d: DetectResult['drafts'][number]): AppProfile {
  const sp = d.suggestedProfile
  return {
    id: `${AUTO_PREFIX}${d.containerName}`,
    name: sp.name ?? `${d.containerName} 自动发现`,
    kind: sp.kind ?? 'directory',
    paths: sp.paths ?? [],
    containers: sp.containers ?? [d.containerName],
    dbPath: sp.dbPath,
    database: sp.database,
    dbUser: sp.dbUser,
    dumpTool: sp.dumpTool,
    passwordRef: sp.passwordRef,
    containerWorkdir: sp.containerWorkdir,
    encrypt: sp.encrypt ?? false,
    consistency: sp.consistency ?? 'best_effort',
    schedule: { mode: 'daily', at: '03:00' },
    targetIds: [],
    keep: 7,
    enabled: false, // ★ 核心安全约定：开关默认关闭
    isDraft: false,
  }
}

/** 单轮扫描：新容器入档（默认停用）+ 消失容器的未启用自动档案清理。绝不覆盖已有档案。 */
export async function scanAndRegister(
  store: Store,
  hub: AlertHub,
  deps: AutoDetectDeps = liveDeps,
): Promise<ScanOutcome> {
  // 注意：必须含停用档案（includeDrafts=全量语义）——刚落库未启用的 auto_ 档案、
  // 用户手工建但暂关的档案，其 containers/paths 都要参与去重与清理判定
  const existing = store.listProfiles({ includeDrafts: true })
  const coveredContainers = coveredContainersOf(existing)
  const existingPaths = coveredPathsOf(existing)
  const { drafts } = await deps.detect(coveredContainers, existingPaths)

  const added: string[] = []
  for (const d of drafts) {
    const id = `${AUTO_PREFIX}${d.containerName}`
    if (store.getProfile(id)) continue // 已存在（可能被用户编辑过）——绝不覆盖
    store.upsertProfile(draftToProfile(d))
    added.push(`${d.containerName}（${d.confidence === 'high' ? '已识别' : '未识别，按数据目录入档'}）`)
  }
  if (added.length > 0) {
    await hub.send(
      'new_app_added',
      `🆕 检测到新应用并已加入档案（备份开关默认关闭）：${added.join('、')}。请到控制台核对后开启。`,
    )
  }

  // 僵尸清理：仅限本模块创建、从未启用、容器已消失的档案（用户开过开关=已接管，保留）
  const running = await deps.runningContainers()
  const removed: string[] = []
  for (const p of store.listProfiles({ includeDrafts: true })) {
    if (!p.id.startsWith(AUTO_PREFIX) || p.enabled) continue
    if (p.containers.length > 0 && p.containers.every((c) => !running.has(c))) {
      store.deleteProfile(p.id)
      removed.push(p.name)
    }
  }
  if (removed.length > 0) {
    await hub.send('auto_profile_removed', `🧹 已自动移除未启用的过期档案（容器已消失）：${removed.join('、')}`)
  }

  return { added, removed }
}

/** 常驻定时扫描：启动立即一轮 + 每 interval 一轮；返回 disposer（serve shutdown 释放）。 */
export function startAutoDetect(store: Store, hub: AlertHub, intervalMs = 6 * 3600_000): () => void {
  const run = (): void => {
    scanAndRegister(store, hub).catch((err: unknown) => {
      // 扫描故障（如无 docker 的开发机）只记日志，不打扰用户、不产生告警轰炸
      console.warn(`[auto-detect] 扫描失败（忽略，下轮重试）：${err instanceof Error ? err.message : String(err)}`)
    })
  }
  run()
  const timer = setInterval(run, intervalMs)
  return () => clearInterval(timer)
}
