#!/usr/bin/env node
/**
 * 档案合并迁移（v2 多类型）：把同一应用的「数据 + 配置」成对档案合并为单档案（parts 多类型）。
 * 在 VPS 上运行：node scripts/merge-pairs.cjs
 * 规则：保留「数据」档案的 id/name 基础（改名为应用名），配置档案字段转为 part，
 *       配置档案的 runs 历史迁移到主档案后删除配置档案行。
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
import { join } from 'node:path'

const db = new Database(join(process.cwd(), 'autobackup.db'))
db.pragma('journal_mode = WAL')

const getProfile = (id) => {
  const row = db.prepare('SELECT profile_json FROM apps WHERE id = ?').get(id)
  return row ? JSON.parse(row.profile_json) : undefined
}

/** 合并配置：主档案 id 保留，配置档案 → part */
const MERGES = [
  {
    mainId: 'vaultwarden',
    newName: 'Vaultwarden',
    configId: 'vaultwarden-config',
  },
  {
    mainId: 'myapi',
    newName: 'myapi',
    configId: 'myapi-config',
  },
  {
    mainId: 'wordpress-db',
    newName: 'WordPress',
    configId: null, // wordpress 的「文件」档案是 wordpress-files
    filesId: 'wordpress-files',
  },
  {
    mainId: 'litellm-db',
    newName: 'LiteLLM',
    configId: 'litellm-config',
  },
]

const tx = db.transaction(() => {
  let merged = 0
  for (const m of MERGES) {
    const main = getProfile(m.mainId)
    if (!main) {
      console.log(`skip: ${m.mainId} not found`)
      continue
    }
    const parts = []
    // 主档案自身字段 → part 1（数据库或数据）
    if (main.kind === 'sqlite') {
      parts.push({ kind: 'sqlite', label: '数据库', dbPath: main.dbPath })
    } else if (main.kind === 'mariadb') {
      parts.push({
        kind: 'mariadb', label: `数据库 ${main.database ?? ''}`.trim(),
        container: main.containers?.[0], database: main.database,
        dumpTool: main.dumpTool, dumpArgs: main.dumpArgs,
        passwordRef: main.passwordRef, containerWorkdir: main.containerWorkdir,
      })
    } else if (main.kind === 'postgres') {
      parts.push({
        kind: 'postgres', label: `数据库 ${main.database ?? ''}`.trim(),
        container: main.containers?.[0], database: main.database, dbUser: main.dbUser,
        dumpTool: main.dumpTool, passwordRef: main.passwordRef,
      })
    } else if (main.kind === 'directory' || main.kind === 'config') {
      parts.push({ kind: main.kind, label: '数据文件', paths: main.paths })
    }
    // 配置档案 → part 2
    if (m.configId) {
      const cfg = getProfile(m.configId)
      if (cfg) {
        parts.push({ kind: 'config', label: '配置文件', paths: cfg.paths })
        // runs 历史迁移到主档案
        db.prepare('UPDATE runs SET profile_id = ? WHERE profile_id = ?').run(m.mainId, m.configId)
        db.prepare('DELETE FROM apps WHERE id = ?').run(m.configId)
        console.log(`merged: ${m.configId} -> ${m.mainId}`)
      }
    }
    // 文件档案 → part（wordpress 特例）
    if (m.filesId) {
      const files = getProfile(m.filesId)
      if (files) {
        parts.push({ kind: 'directory', label: '站点文件', paths: files.paths })
        db.prepare('UPDATE runs SET profile_id = ? WHERE profile_id = ?').run(m.mainId, m.filesId)
        db.prepare('DELETE FROM apps WHERE id = ?').run(m.filesId)
        console.log(`merged: ${m.filesId} -> ${m.mainId}`)
      }
    }
    // 写回主档案（名字去掉「数据/数据库」后缀，schedule/targetIds/keep/encrypt 用主档案的）
    main.name = m.newName
    main.parts = parts
    main.kind = parts[0]?.kind ?? main.kind
    db.prepare('UPDATE apps SET name = ?, kind = ?, profile_json = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id = ?')
      .run(main.name, main.kind, JSON.stringify(main), m.mainId)
    console.log(`✅ ${m.mainId} → 「${m.newName}」with ${parts.length} parts (${parts.map((p) => p.kind).join('+')})`)
    merged++
  }
  return merged
})

const n = tx()
const remaining = db.prepare('SELECT id, name, kind FROM apps ORDER BY name').all()
console.log(`\nmerged ${n} pairs. remaining profiles:`)
for (const r of remaining) console.log(`  ${r.id} | ${r.name} | ${r.kind}`)
db.close()
