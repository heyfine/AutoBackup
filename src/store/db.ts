import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AppProfile, BackupTarget, RunRecord, PushRecord } from '../types.js'

/**
 * 存储：SQLite 3 表（apps/targets/runs），符合落地方案 D 系列决策。
 * runs.pushes 为 JSON 列（目标数 2-4 个，无需独立表）。
 */
export class Store {
  readonly db: Database.Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('sqlite','mariadb','postgres','directory','config')),
        profile_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        is_draft INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `)
    // 增量迁移：老库补列（targets.allow_unencrypted；表不存在时跳过，由下方 CREATE 处理）
    const hasTargets = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='targets'")
      .get()
    if (hasTargets) {
      const targetCols = (this.db.pragma('table_info(targets)') as { name: string }[]).map((c) => c.name)
      if (!targetCols.includes('allow_unencrypted')) {
        this.db.exec('ALTER TABLE targets ADD COLUMN allow_unencrypted INTEGER NOT NULL DEFAULT 1')
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        username TEXT NOT NULL,
        password_ref TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        keep INTEGER NOT NULL DEFAULT 7,
        capacity_quota_mb INTEGER,
        capacity_warn_pct INTEGER NOT NULL DEFAULT 85,
        timeout_min INTEGER NOT NULL DEFAULT 30,
        allow_unencrypted INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual','retry')),
        status TEXT NOT NULL CHECK (status IN ('running','success','failed','skipped')),
        stage TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        local_path TEXT,
        size_bytes INTEGER,
        sha256 TEXT,
        encrypted INTEGER NOT NULL DEFAULT 0,
        pushes_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        /** 崩溃恢复：心跳时间，进程启动时扫描超时 run 标记 interrupted 状态后复用 artifact */
        heartbeat_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_profile ON runs(profile_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    `)
  }

  // ---- apps ----

  upsertProfile(p: AppProfile): void {
    this.db
      .prepare(
        `INSERT INTO apps (id, name, kind, profile_json, enabled, is_draft, updated_at)
         VALUES (@id, @name, @kind, @profileJson, @enabled, @isDraft, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(id) DO UPDATE SET
           name=@name, kind=@kind, profile_json=@profileJson,
           enabled=@enabled, is_draft=@isDraft,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run({
        id: p.id,
        name: p.name,
        kind: p.kind,
        profileJson: JSON.stringify(p),
        enabled: p.enabled ? 1 : 0,
        isDraft: p.isDraft ? 1 : 0,
      })
  }

  getProfile(id: string): AppProfile | undefined {
    const row = this.db.prepare('SELECT profile_json FROM apps WHERE id = ?').get(id) as
      | { profile_json: string }
      | undefined
    return row ? (JSON.parse(row.profile_json) as AppProfile) : undefined
  }

  listProfiles(opts?: { includeDrafts?: boolean }): AppProfile[] {
    const rows = (
      opts?.includeDrafts
        ? this.db.prepare('SELECT profile_json FROM apps ORDER BY name')
        : this.db.prepare('SELECT profile_json FROM apps WHERE is_draft = 0 AND enabled = 1 ORDER BY name')
    ).all() as { profile_json: string }[]
    return rows.map((r) => JSON.parse(r.profile_json) as AppProfile)
  }

  deleteProfile(id: string): void {
    this.db.prepare('DELETE FROM apps WHERE id = ?').run(id)
  }

  // ---- targets ----

  upsertTarget(t: BackupTarget): void {
    this.db
      .prepare(
        `INSERT INTO targets (id, name, url, username, password_ref, enabled, keep, capacity_quota_mb, capacity_warn_pct, timeout_min, allow_unencrypted)
         VALUES (@id, @name, @url, @username, @passwordRef, @enabled, @keep, @capacityQuotaMb, @capacityWarnPct, @timeoutMin, @allowUnencrypted)
         ON CONFLICT(id) DO UPDATE SET
           name=@name, url=@url, username=@username, password_ref=@passwordRef,
           enabled=@enabled, keep=@keep, capacity_quota_mb=@capacityQuotaMb,
           capacity_warn_pct=@capacityWarnPct, timeout_min=@timeoutMin, allow_unencrypted=@allowUnencrypted`,
      )
      .run({
        id: t.id,
        name: t.name,
        url: t.url,
        username: t.username,
        passwordRef: t.passwordRef,
        enabled: t.enabled ? 1 : 0,
        keep: t.keep,
        capacityQuotaMb: t.capacityQuotaMb ?? null,
        capacityWarnPct: t.capacityWarnPct,
        timeoutMin: t.timeoutMin,
        allowUnencrypted: t.allowUnencrypted ? 1 : 0,
      })
  }

  deleteTarget(id: string): void {
    this.db.prepare('DELETE FROM targets WHERE id = ?').run(id)
  }

  listTargets(enabledOnly = true): BackupTarget[] {
    const rows = (
      enabledOnly
        ? this.db.prepare('SELECT * FROM targets WHERE enabled = 1 ORDER BY name')
        : this.db.prepare('SELECT * FROM targets ORDER BY created_at')
    ).all() as Record<string, unknown>[]
    return rows.map(rowToTarget)
  }

  getTarget(id: string): BackupTarget | undefined {
    const row = this.db.prepare('SELECT * FROM targets WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToTarget(row) : undefined
  }

  /** 新目标 id（password_ref 自动生成） */
  newTargetId(_name: string): { id: string; passwordRef: string } {
    const id = `t_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`
    return { id, passwordRef: `WEBDAV_${id.toUpperCase().replace(/-/g, '_')}_PASS` }
  }

  // ---- runs ----

  startRun(r: Omit<RunRecord, 'pushes'> & { pushes?: PushRecord[] }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, profile_id, trigger, status, stage, started_at, local_path, size_bytes, sha256, encrypted, pushes_json, heartbeat_at)
         VALUES (@id, @profileId, @trigger, @status, @stage, @startedAt, @localPath, @sizeBytes, @sha256, @encrypted, @pushesJson, @heartbeatAt)`,
      )
      .run({
        id: r.id,
        profileId: r.profileId,
        trigger: r.trigger,
        status: r.status,
        stage: r.stage,
        startedAt: r.startedAt,
        localPath: r.localPath ?? null,
        sizeBytes: r.sizeBytes ?? null,
        sha256: r.sha256 ?? null,
        encrypted: r.encrypted ? 1 : 0,
        pushesJson: JSON.stringify(r.pushes ?? []),
        heartbeatAt: r.startedAt,
      })
  }

  updateRun(id: string, patch: Partial<Pick<RunRecord, 'status' | 'stage' | 'finishedAt' | 'durationMs' | 'localPath' | 'sizeBytes' | 'sha256' | 'error' | 'pushes'>>): void {
    const sets: string[] = []
    const params: Record<string, unknown> = { id }
    if (patch.status !== undefined) { sets.push('status = @status'); params.status = patch.status }
    if (patch.stage !== undefined) { sets.push('stage = @stage'); params.stage = patch.stage }
    if (patch.finishedAt !== undefined) { sets.push('finished_at = @finishedAt'); params.finishedAt = patch.finishedAt }
    if (patch.durationMs !== undefined) { sets.push('duration_ms = @durationMs'); params.durationMs = patch.durationMs }
    if (patch.localPath !== undefined) { sets.push('local_path = @localPath'); params.localPath = patch.localPath }
    if (patch.sizeBytes !== undefined) { sets.push('size_bytes = @sizeBytes'); params.sizeBytes = patch.sizeBytes }
    if (patch.sha256 !== undefined) { sets.push('sha256 = @sha256'); params.sha256 = patch.sha256 }
    if (patch.error !== undefined) { sets.push('error = @error'); params.error = patch.error }
    if (patch.pushes !== undefined) { sets.push('pushes_json = @pushesJson'); params.pushesJson = JSON.stringify(patch.pushes) }
    if (sets.length === 0) return
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }

  heartbeatRun(id: string): void {
    this.db
      .prepare(`UPDATE runs SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(id)
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToRun(row) : undefined
  }

  listRuns(profileId?: string, limit = 50): RunRecord[] {
    const rows = (
      profileId
        ? this.db
            .prepare('SELECT * FROM runs WHERE profile_id = ? ORDER BY started_at DESC LIMIT ?')
            .all(profileId, limit)
        : this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit)
    ) as Record<string, unknown>[]
    return rows.map(rowToRun)
  }

  /** 崩溃恢复：找心跳超时的 running run */
  listStaleRuns(timeoutMs: number): RunRecord[] {
    const cutoff = new Date(Date.now() - timeoutMs).toISOString()
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE status = 'running' AND heartbeat_at < ? ORDER BY started_at`,
      )
      .all(cutoff) as Record<string, unknown>[]
    return rows.map(rowToRun)
  }

  /** 上一个成功的同 profile run（断点续推复用 artifact） */
  lastReusableRun(profileId: string): RunRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM runs WHERE profile_id = ? AND status = 'success' AND local_path IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(profileId) as Record<string, unknown> | undefined
    return row ? rowToRun(row) : undefined
  }

  close(): void {
    this.db.close()
  }
}

function rowToTarget(row: Record<string, unknown>): BackupTarget {
  return {
    id: row.id as string,
    name: row.name as string,
    url: row.url as string,
    username: row.username as string,
    passwordRef: row.password_ref as string,
    enabled: row.enabled === 1,
    keep: row.keep as number,
    capacityQuotaMb: (row.capacity_quota_mb as number | null) ?? undefined,
    capacityWarnPct: row.capacity_warn_pct as number,
    timeoutMin: row.timeout_min as number,
    allowUnencrypted: row.allow_unencrypted !== 0,
  }
}

function rowToRun(row: Record<string, unknown>): RunRecord {
  return {
    id: row.id as string,
    profileId: row.profile_id as string,
    trigger: row.trigger as RunRecord['trigger'],
    status: row.status as RunRecord['status'],
    stage: row.stage as string,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? undefined,
    durationMs: (row.duration_ms as number | null) ?? undefined,
    localPath: (row.local_path as string | null) ?? undefined,
    sizeBytes: (row.size_bytes as number | null) ?? undefined,
    sha256: (row.sha256 as string | null) ?? undefined,
    encrypted: row.encrypted === 1,
    pushes: JSON.parse((row.pushes_json as string) ?? '[]') as PushRecord[],
    error: (row.error as string | null) ?? undefined,
  }
}
