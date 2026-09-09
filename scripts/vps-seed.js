#!/usr/bin/env node
/**
 * VPS 档案注入：基于 2026-09-09 CEO 实测盘点写入 12 个档案 + Koofr 目标占位。
 * 在 VPS 上运行：node dist/scripts/vps-seed.js
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
import { join } from 'node:path'

const db = new Database(join(process.cwd(), 'autobackup.db'))
db.pragma('journal_mode = WAL')

db.exec(`CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sqlite','mariadb','postgres','directory','config')),
  profile_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, is_draft INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, username TEXT NOT NULL,
  password_ref TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, keep INTEGER NOT NULL DEFAULT 7,
  capacity_quota_mb INTEGER, capacity_warn_pct INTEGER NOT NULL DEFAULT 85, timeout_min INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual','retry')),
  status TEXT NOT NULL CHECK (status IN ('running','success','failed','skipped')),
  stage TEXT NOT NULL DEFAULT '', started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER,
  local_path TEXT, size_bytes INTEGER, sha256 TEXT, encrypted INTEGER NOT NULL DEFAULT 0,
  pushes_json TEXT NOT NULL DEFAULT '[]', error TEXT, heartbeat_at TEXT);
CREATE INDEX IF NOT EXISTS idx_runs_profile ON runs(profile_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);`)

const upsert = db.prepare(`INSERT INTO apps (id, name, kind, profile_json, enabled, is_draft)
  VALUES (?, ?, ?, ?, ?, 0)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, profile_json=excluded.profile_json, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)

const P = (p) => upsert.run(p.id, p.name, p.kind, JSON.stringify(p), p.enabled ? 1 : 0)

/** 加密开关：敏感档案默认开（方案 D6） */
const ENC = true
const NO = false

const profiles = [
  { id: 'vaultwarden', name: 'Vaultwarden 数据', kind: 'sqlite', paths: [], containers: [], dbPath: '/opt/vaultwarden/data/db.sqlite3', encrypt: ENC, consistency: 'consistent', scheduleAt: '03:30', enabled: true, isDraft: false },
  { id: 'vaultwarden-config', name: 'Vaultwarden 配置', kind: 'config', paths: ['/opt/vaultwarden/compose.yaml', '/opt/vaultwarden/secrets'], containers: [], encrypt: ENC, consistency: 'best_effort', enabled: true, isDraft: false },
  { id: 'myapi', name: 'myapi 网关数据', kind: 'sqlite', paths: [], containers: [], dbPath: '/root/myapi/data/gateway.db', encrypt: ENC, consistency: 'consistent', enabled: true, isDraft: false },
  { id: 'myapi-config', name: 'myapi 配置', kind: 'config', paths: ['/root/myapi'], containers: [], encrypt: ENC, consistency: 'best_effort', enabled: true, isDraft: false },
  { id: 'wordpress-files', name: 'WordPress 文件', kind: 'directory', paths: ['/opt/wp-blog/wordpress'], containers: ['wp-blog-wordpress-1'], encrypt: NO, consistency: 'best_effort', enabled: true, isDraft: false },
  { id: 'wordpress-db', name: 'WordPress 数据库', kind: 'mariadb', paths: [], containers: ['wp-blog-db-1'], database: 'wordpress', dumpTool: 'mariadb-dump', dumpArgs: '--single-transaction --quick --routines --events', passwordRef: 'MARIADB_ROOT_PASS', containerWorkdir: '/tmp', encrypt: NO, consistency: 'consistent', enabled: true, isDraft: false },
  { id: 'litellm-db', name: 'LiteLLM 数据库', kind: 'postgres', paths: [], containers: ['litellm-db-1'], database: 'litellm', dumpTool: 'pg_dump', passwordRef: 'LITELLM_PG_PASS', encrypt: NO, consistency: 'consistent', enabled: true, isDraft: false },
  { id: 'litellm-config', name: 'LiteLLM 配置', kind: 'config', paths: ['/opt/litellm'], containers: [], encrypt: ENC, consistency: 'best_effort', enabled: true, isDraft: false },
  { id: 'dufs-data', name: 'dufs 数据（双容器共用）', kind: 'directory', paths: ['/opt/data'], containers: ['dufs-public', 'dufs-private'], encrypt: NO, consistency: 'best_effort', enabled: true, isDraft: false },
  { id: 'ddns-go', name: 'ddns-go 配置', kind: 'config', paths: ['/www/dk_project/dk_app/ddns_go/ddns_go_wHP3/data'], containers: [], encrypt: ENC, consistency: 'best_effort', enabled: true, isDraft: false },
  { id: 'nginx-vhost', name: 'Nginx vhost 配置', kind: 'config', paths: ['/www/server/panel/vhost/nginx'], containers: [], encrypt: ENC, consistency: 'best_effort', enabled: true, isDraft: false },
  { id: 'autobackup-self', name: '备份工具自身', kind: 'config', paths: ['/opt/auto-backup/secrets.env', '/opt/auto-backup/autobackup.db'], containers: [], encrypt: ENC, consistency: 'best_effort', enabled: true, isDraft: false },
]

for (const p of profiles) P(p)

const target = {
  id: 'koofr-main',
  name: 'Koofr 主目标',
  url: 'https://app.koofr.net/dav/Koofr/autobackup',
  username: 'PLACEHOLDER',
  password_ref: 'WEBDAV_KOOFR_PASS',
  enabled: 0, // 配好凭据前禁用
  keep: 7,
  capacity_quota_mb: 10240,
  capacity_warn_pct: 85,
  timeout_min: 30,
}
db.prepare(`INSERT INTO targets (id, name, url, username, password_ref, enabled, keep, capacity_quota_mb, capacity_warn_pct, timeout_min)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, url=excluded.url, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
  .run(target.id, target.name, target.url, target.username, target.password_ref, target.enabled, target.keep, target.capacity_quota_mb, target.capacity_warn_pct, target.timeout_min)

console.log(`seeded ${profiles.length} profiles + 1 target (disabled until credentials configured)`)
db.close()
