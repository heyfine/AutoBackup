/**
 * 本地端到端演练：注入测试档案 + 测试目标（本地模拟 WebDAV 由 test:webdav 起）。
 * 用法：node dist/scripts/seed.js
 */
import { Store } from '../src/store/db.js'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppProfile, BackupTarget } from '../src/types.js'

const home = process.cwd()
const store = new Store(join(home, 'autobackup.db'))

// 造一个真实的小目录档案
const srcDir = mkdtempSync(join(tmpdir(), 'ab-seed-'))
writeFileSync(join(srcDir, 'important.txt'), `关键数据 ${new Date().toISOString()}`)
mkdirSync(join(srcDir, 'nested'))
writeFileSync(join(srcDir, 'nested', 'config.json'), '{"api":"keys-are-here"}')

const profile: AppProfile = {
  id: 'test-dir',
  name: '测试目录',
  kind: 'directory',
  paths: [srcDir],
  containers: [],
  encrypt: false,
  consistency: 'best_effort',
  schedule: { mode: 'daily', at: '03:00' },
  targetIds: [],
  keep: 7,
  enabled: true,
  isDraft: false,
}
store.upsertProfile(profile)

// 本地模拟 WebDAV 目标（配合 webdav-server 启动）
const target: BackupTarget = {
  id: 'local-webdav',
  name: '本地模拟 WebDAV',
  url: 'http://127.0.0.1:9800/backup',
  username: 'test',
  passwordRef: 'TEST_PASS',
  enabled: true,
  keep: 5,
  capacityWarnPct: 85,
  timeoutMin: 5,
  allowUnencrypted: true,
}
store.upsertTarget(target)
console.log('seeded: profile test-dir + target local-webdav (http://127.0.0.1:9800/backup)')
console.log('srcDir:', srcDir)
store.close()
