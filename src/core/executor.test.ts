import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pack } from './packer.js'
import { takeSnapshot } from './executor.js'
import type { AppProfile } from '../types.js'

// Windows 无 age 二进制时跳过加密用例
const hasAge = (() => {
  try {
    execFileSync('age', ['--version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()

describe('executor + packer (M1 核心)', () => {
  let workdir: string
  let homeDir: string

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'ab-test-'))
    homeDir = await mkdtemp(join(tmpdir(), 'ab-home-'))
  })
  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true }).catch(() => {})
    await rm(homeDir, { recursive: true, force: true }).catch(() => {})
  })

  it('sqlite 执行器：创建测试库 → .backup → integrity_check 通过 → tar.gz 打包', async () => {
    // 用 better-sqlite3 造测试库（不依赖宿主 sqlite3 CLI）
    const { mkdtemp: mkd } = await import('node:fs/promises')
    const dbDir = await mkd(join(workdir, 'db-'))
    const dbPath = join(dbDir, 'test.db')
    const Database = (await import('better-sqlite3')).default
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, v TEXT)')
    seed.prepare('INSERT INTO items(v) VALUES (?)').run('a')
    seed.prepare('INSERT INTO items(v) VALUES (?)').run('b')
    seed.close()

    const profile: AppProfile = {
      id: 'test-sqlite',
      name: 'Test SQLite',
      kind: 'sqlite',
      paths: [],
      containers: [],
      dbPath,
      encrypt: false,
      consistency: 'consistent',
      enabled: true,
      isDraft: false,
    }
    const snap = await takeSnapshot(profile, () => 'unused', homeDir)
    expect(snap.artifactName).toBe('snapshot.db')
    expect(snap.detail).toContain('integrity_check ok')

    const packed = await pack(profile, snap.stagingDir, {
      homeDir,
      snapshotAt: new Date().toISOString(),
    })
    expect(packed.sizeBytes).toBeGreaterThan(0)
    expect(packed.manifest.kind).toBe('sqlite')
    expect(packed.manifest.encryption).toBe('none')
    expect(packed.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(packed.manifestPath).toContain('.manifest.json')
  }, 30000)

  it('directory 执行器：路径校验失败 fail fast', async () => {
    const profile: AppProfile = {
      id: 'test-dir-bad',
      name: 'Bad Dir',
      kind: 'directory',
      paths: [join(workdir, 'not-exist-path')],
      containers: [],
      encrypt: false,
      consistency: 'best_effort',
      enabled: true,
      isDraft: false,
    }
    await expect(takeSnapshot(profile, () => '', homeDir)).rejects.toThrow(/path not accessible/)
  })

  it('directory 打包：多文件 tar.gz 往返内容一致', async () => {
    const srcDir = join(workdir, 'src')
    const sub = join(srcDir, 'sub')
    await mkdir(sub, { recursive: true })
    await writeFile(join(srcDir, 'a.txt'), 'hello A')
    await writeFile(join(sub, 'b.txt'), 'hello B')
    const profile: AppProfile = {
      id: 'test-dir',
      name: 'Test Dir',
      kind: 'directory',
      paths: [srcDir],
      containers: [],
      encrypt: false,
      consistency: 'best_effort',
      enabled: true,
      isDraft: false,
    }
    const snap = await takeSnapshot(profile, () => '', homeDir)
    const packed = await pack(profile, snap.stagingDir, { homeDir, snapshotAt: new Date().toISOString() })
    expect(packed.artifactPath).toMatch(/\.tar\.gz$/)

    // 往返验证：纯 Node tar-stream 解包，内容一致（跨平台，不依赖系统 tar）
    const { extract } = await import('tar-stream')
    const { createReadStream } = await import('node:fs')
    const { createGunzip } = await import('node:zlib')
    const contents = new Map<string, string>()
    const ex = extract()
    ex.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on('data', (c: unknown) => chunks.push(c as Buffer))
      stream.on('end', () => {
        contents.set(header.name, Buffer.concat(chunks).toString('utf8'))
        next()
      })
    })
    await new Promise<void>((resolve, reject) => {
      ex.on('finish', resolve)
      ex.on('error', reject)
      createReadStream(packed.artifactPath).pipe(createGunzip()).pipe(ex)
    })
    // directory 档案以路径末段为根：src → src/a.txt
    expect(contents.get('src/a.txt')).toBe('hello A')
    expect(contents.get('src/sub/b.txt')).toBe('hello B')
    // 所有条目必须是相对路径（不允许绝对路径，防还原释放错位）
    for (const name of contents.keys()) {
      expect(name.startsWith('/') || /^[a-zA-Z]:/.test(name)).toBe(false)
    }
  }, 30000)

  it('packer：无 age 时跳过加密用例', async () => {
    if (!hasAge) {
      console.log('SKIP: age binary not available on this machine')
      return
    }
    // 有 age 时验证加密产物生成
    const srcDir = join(workdir, 'enc-src')
    await mkdir(srcDir, { recursive: true })
    await writeFile(join(srcDir, 'secret.txt'), 'top secret')
    const profile: AppProfile = {
      id: 'test-enc',
      name: 'Enc Test',
      kind: 'directory',
      paths: [srcDir],
      containers: [],
      encrypt: true,
      consistency: 'best_effort',
      enabled: true,
      isDraft: false,
    }
    const snap = await takeSnapshot(profile, () => '', homeDir)
    const packed = await pack(profile, snap.stagingDir, {
      homeDir,
      snapshotAt: new Date().toISOString(),
      ageRecipient: 'age1test-not-real-key',
    })
    expect(packed.artifactPath).toMatch(/\.age$/)
    // 加密后内容不应含明文
    const raw = await readFile(packed.artifactPath, 'utf8').catch(() => '')
    expect(raw).not.toContain('top secret')
  }, 30000)

  it('secrets：缺失键 fail fast，引号剥离', async () => {
    const { Secrets } = await import('./secrets.js')
    const envPath = join(workdir, 'secrets.env')
    await writeFile(envPath, '# comment\nFOO=bar\nQUOTED="hello world"\nEMPTY=\n')
    const s = new Secrets(envPath)
    expect(s.get('FOO')).toBe('bar')
    expect(s.get('QUOTED')).toBe('hello world')
    expect(s.has('EMPTY')).toBe(false)
    expect(() => s.get('MISSING')).toThrow(/secrets key not found: MISSING/)
  })

  it('store：3 表 CRUD + runs 状态机', async () => {
    const { Store } = await import('../store/db.js')
    const dbPath = join(workdir, `store-${Date.now()}.db`)
    const store = new Store(dbPath)

    const profile: AppProfile = {
      id: 'p1',
      name: 'P1',
      kind: 'directory',
      paths: ['/tmp'],
      containers: [],
      encrypt: false,
      consistency: 'best_effort',
      enabled: true,
      isDraft: false,
    }
    store.upsertProfile(profile)
    expect(store.getProfile('p1')?.name).toBe('P1')

    const target = {
      id: 't1',
      name: 'Koofr',
      url: 'https://app.koofr.net/dav/Koofr/backup',
      username: 'u',
      passwordRef: 'WEBDAV_1_PASS',
      enabled: true,
      keep: 7,
      capacityWarnPct: 85,
      timeoutMin: 30,
    }
    store.upsertTarget(target)
    expect(store.listTargets()[0]?.keep).toBe(7)

    const runId = `run-${Date.now()}`
    store.startRun({
      id: runId,
      profileId: 'p1',
      trigger: 'schedule',
      status: 'running',
      stage: 'snapshot',
      startedAt: new Date().toISOString(),
      encrypted: false,
    })
    store.updateRun(runId, {
      status: 'success',
      stage: 'done',
      finishedAt: new Date().toISOString(),
      durationMs: 1234,
      localPath: join(workdir, 'fake-artifact.tar.gz'),
      sizeBytes: 456,
      sha256: 'a'.repeat(64),
      pushes: [{ targetId: 't1', status: 'ok', attempts: 1, bytesSent: 456 }],
    })
    const run = store.getRun(runId)
    expect(run?.status).toBe('success')
    expect(run?.pushes[0]?.targetId).toBe('t1')
    expect(store.listRuns('p1')).toHaveLength(1)
    expect(store.lastReusableRun('p1')?.id).toBe(runId)

    store.deleteProfile('p1')
    expect(store.getProfile('p1')).toBeUndefined()
    store.close()
  })
})
