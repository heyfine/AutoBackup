import { rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { AppProfile, PushRecord, RunRecord } from '../types.js'
import type { Store } from '../store/db.js'
import type { Secrets } from './secrets.js'
import { takeSnapshot } from './executor.js'
import { pack } from './packer.js'
import { putFile, listFiles, deleteFile } from './webdav.js'

export interface NotifySink {
  send(event: string, message: string, source?: string): Promise<unknown>
}

export interface PipelineDeps {
  store: Store
  secrets: Secrets
  homeDir: string
  notify: NotifySink
  toolVersion: string
}

/** 心跳超时（崩溃恢复判定） */
const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000
/** 重试退避（评审收敛：1s/5s/30s） */
const RETRY_DELAYS_MS = [1000, 5000, 30000]

/**
 * 备份流水线：快照 → 打包+加密+manifest → 串行推送多目标（单目标失败不阻塞）→ 保留裁剪。
 * 断点复用：本地 artifact 完整（sha256 已记）且同 profile 上次 run 成功，push 失败的下轮 tick 直接重推。
 */
export class Pipeline {
  constructor(private readonly deps: PipelineDeps) {}

  async runProfile(profile: AppProfile, trigger: RunRecord['trigger'] = 'schedule'): Promise<RunRecord> {
    const { store } = this.deps
    const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`
    const startedAt = new Date().toISOString()
    store.startRun({
      id: runId,
      profileId: profile.id,
      trigger,
      status: 'running',
      stage: 'snapshot',
      startedAt,
      encrypted: profile.encrypt,
    })

    const hb = setInterval(() => store.heartbeatRun(runId), 30_000)
    try {
      // 1. 快照（一致性）
      const snap = await takeSnapshot(profile, (ref) => this.deps.secrets.get(ref), this.deps.homeDir)
      store.updateRun(runId, { stage: 'pack' })

      // 2. 打包 + 加密 + manifest
      const ageRecipient = profile.encrypt ? this.deps.secrets.getOptional('AGE_RECIPIENT') : undefined
      if (profile.encrypt && !ageRecipient) {
        throw new Error(`profile ${profile.id} requires encryption but AGE_RECIPIENT not set`)
      }
      const packed = await pack(profile, snap.stagingDir, {
        homeDir: this.deps.homeDir,
        snapshotAt: startedAt,
        ageRecipient,
      })
      // staging 清理（产物已入 homeDir）
      await rm(snap.stagingDir, { recursive: true, force: true }).catch(() => {})

      store.updateRun(runId, {
        stage: 'push',
        localPath: packed.artifactPath,
        sizeBytes: packed.sizeBytes,
        sha256: packed.sha256,
      })

      // 3. 串行推送多目标（单目标失败不阻塞其他）
      // 档案绑定 targetIds（空=全部启用目标）；allowUnencrypted=false 的目标拒绝未加密 artifact
      const allEnabled = store.listTargets(true)
      const targets =
        profile.targetIds.length > 0
          ? allEnabled.filter((t) => profile.targetIds.includes(t.id))
          : allEnabled
      const pushes: PushRecord[] = targets.map((t) => ({
        targetId: t.id,
        status: 'pending',
        attempts: 0,
      }))
      store.updateRun(runId, { pushes })

      const fileName = packed.artifactPath.split(/[\\/]/).pop() ?? 'artifact.tar.gz'

      let allOk = true
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]
        if (!t) continue
        const push = pushes[i]
        if (!push) continue
        const creds = {
          url: remoteSubdir(t.url, profile.id),
          username: t.username,
          password: this.deps.secrets.get(t.passwordRef),
        }
        // 重试 1s/5s/30s（评审收敛值）
        for (let attempt = 1; attempt <= 3; attempt++) {
          push.attempts = attempt
          try {
            const r = await putFile(creds, creds.url, fileName, packed.artifactPath, { timeoutMin: t.timeoutMin })
            // 上传 manifest（永不加密清单，供远端浏览）
            await putFile(creds, creds.url, `${fileName}.manifest.json`, packed.manifestPath, { timeoutMin: 5 }).catch(() => {})
            push.status = 'ok'
            push.bytesSent = r.bytesSent
            push.remotePath = `${creds.url}/${fileName}`
            break
          } catch (err) {
            push.error = err instanceof Error ? err.message : String(err)
            if (attempt < 3) {
              await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 5000)
            } else {
              push.status = 'failed'
              allOk = false
            }
          }
        }
        store.updateRun(runId, { pushes })
      }

      // 4. 保留裁剪（仅对全部推送成功的目标执行；四保护条款在 retention 模块内）
      store.updateRun(runId, { stage: 'retention' })
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i]
        const push = pushes[i]
        if (!t || !push || push.status !== 'ok') continue
        try {
          const pruned = await this.applyRetention(t, profile)
          if (pruned.deleted > 0) {
            await this.deps.notify.send(
              'quota_pruned',
              `[AutoBackup] ${t.name}/${profile.id}: 容量/份数触发裁剪，删除 ${pruned.deleted} 个旧备份（保 ${pruned.kept} 份）`,
              `quota:${t.id}:${profile.id}`,
            )
          }
        } catch (err) {
          // 裁剪失败不标记 run 失败（备份本体已成功），但告警
          await this.deps.notify.send(
            'backup_failed',
            `[AutoBackup] ${t.name}/${profile.id}: 保留裁剪失败（备份本体已成功）：${err instanceof Error ? err.message : String(err)}`,
            `retention:${t.id}:${profile.id}`,
          )
        }
      }

      const finishedAt = new Date().toISOString()
      const durationMs = Date.now() - new Date(startedAt).getTime()
      const status: RunRecord['status'] = allOk ? 'success' : 'failed'
      store.updateRun(runId, {
        status,
        stage: 'done',
        finishedAt,
        durationMs,
        error: allOk ? undefined : pushes.filter((p) => p.status === 'failed').map((p) => `${p.targetId}: ${p.error}`).join('; '),
      })
      // 调度依赖：记录 lastRunAt（schedule 触发时更新）
      if (trigger === 'schedule' && status === 'success') {
        const cur = store.getProfile(profile.id)
        if (cur) store.upsertProfile({ ...cur, lastRunAt: finishedAt })
      }

      if (allOk) {
        // 成功静默，仅复位 AlertHub 的失败去重状态（下轮再失败时恢复首次告警语义）
        await this.deps.notify.send('backup_ok', `[AutoBackup] ✅ ${profile.name} 备份成功`, `backup:${profile.id}`)
      } else {
        const failed = pushes.filter((p) => p.status === 'failed')
        await this.deps.notify.send(
          'backup_failed',
          `[AutoBackup] ❌ ${profile.name} 备份推送失败：${failed.map((p) => p.targetId).join(', ')}（快照本地已保存）`,
          `backup:${profile.id}`,
        )
      }

      const result = store.getRun(runId)
      if (!result) throw new Error('run vanished after completion')
      return result
    } catch (err) {
      const finishedAt = new Date().toISOString()
      const message = err instanceof Error ? err.message : String(err)
      store.updateRun(runId, {
        status: 'failed',
        stage: 'error',
        finishedAt,
        durationMs: Date.now() - new Date(startedAt).getTime(),
        error: message,
      })
      await this.deps.notify.send('backup_failed', `[AutoBackup] ❌ ${profile.name} 备份失败：${message}`, `backup:${profile.id}`)
      const result = store.getRun(runId)
      if (!result) throw new Error('run vanished after failure')
      return result
    } finally {
      clearInterval(hb)
    }
  }

  /** 保留策略：份数 + 容量水位，删最早；四保护条款（§3.1） */
  async applyRetention(
    target: { id: string; url: string; username: string; passwordRef: string; keep: number; capacityQuotaMb?: number; timeoutMin: number },
    profile: AppProfile,
  ): Promise<{ deleted: number; kept: number }> {
    const creds = {
      url: remoteSubdir(target.url, profile.id),
      username: target.username,
      password: this.deps.secrets.get(target.passwordRef),
    }
    const files = (await listFiles(creds))
      .filter((f) => f.name.endsWith('.tar.gz') || f.name.endsWith('.tar.gz.age') || f.name.endsWith('.manifest.json'))
      .filter((f) => !f.name.endsWith('.manifest.json')) // manifest 跟随主包，不独立计数
      .sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt)) // 旧 → 新

    let keepN = profile.keep > 0 ? profile.keep : target.keep
    let deleted = 0

    // 容量水位兜底：超配额 → 迭代减 keep
    if (target.capacityQuotaMb) {
      let totalBytes = files.reduce((s, f) => s + f.size, 0)
      const quota = target.capacityQuotaMb * 1024 * 1024
      while (totalBytes > quota * 0.85 && keepN > 3) {
        keepN--
        totalBytes = files.slice(-keepN).reduce((s, f) => s + f.size, 0)
      }
    }

    // 四保护条款 a)：至少保留 3 份
    keepN = Math.max(keepN, 3)
    // 四保护条款 b)：48h 内的快照不删
    const cutoff = Date.now() - 48 * 3600 * 1000
    const recent = files.filter((f) => new Date(f.modifiedAt).getTime() > cutoff).length
    keepN = Math.max(keepN, recent)

    const toDelete = files.slice(0, Math.max(0, files.length - keepN))
    for (const f of toDelete) {
      const ok = await deleteFile(creds, f.name)
      if (ok) deleted++
      else break // 删除失败即停（尽力而为，下轮再清）
    }
    return { deleted, kept: files.length - deleted }
  }

  /** 崩溃恢复：启动时调用。心跳超时 run 标记 failed；有完整 artifact 的提示可重试。 */
  async recoverStaleRuns(): Promise<number> {
    const stale = this.deps.store.listStaleRuns(HEARTBEAT_TIMEOUT_MS)
    for (const run of stale) {
      this.deps.store.updateRun(run.id, {
        status: 'failed',
        stage: 'interrupted',
        finishedAt: new Date().toISOString(),
        error: '进程中断（心跳超时），由启动恢复标记',
      })
      if (run.localPath && existsSync(run.localPath)) {
        await this.deps.notify.send(
          'backup_failed',
          `[AutoBackup] ⚠️ ${run.profileId} 上次备份进程中断，本地 artifact 已保留（sha256 在案），可手动重跑`,
          `backup:${run.profileId}`,
        )
      }
    }
    return stale.length
  }
}

/** 目标 URL + 档案子目录（{target.url}/{profileId}），保留目录结构不编码斜杠 */
function remoteSubdir(baseUrl: string, profileId: string): string {
  const normalized = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
  return `${normalized}/${profileId}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
