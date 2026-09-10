import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppProfile, ProfilePart, ProfileKind } from '../types.js'

const execFileAsync = promisify(execFile)

export interface SnapshotResult {
  /** 快照产物所在目录（打包器接管后删除） */
  stagingDir: string
  /** 产物文件相对 stagingDir 的路径 */
  artifactName: string
  /** 一致性验证信息（写 manifest） */
  detail: string
}

export class ExecutorError extends Error {
  constructor(
    message: string,
    readonly profileId: string,
    readonly stderr?: string,
  ) {
    super(message)
    this.name = 'ExecutorError'
  }
}

/**
 * 一致性快照执行器。
 * 硬规则（AGENTS.md #2/#3）：SQLite 走 VACUUM INTO；MariaDB/PG 走容器内 dump；
 * 密码只走 --defaults-extra-file / env 注入，禁止命令行参数。
 */
export async function takeSnapshot(profile: AppProfile, secrets: (ref: string) => string, homeDir: string): Promise<SnapshotResult> {
  const stagingDir = await mkdtemp(join(homeDir, 'snapshot-'))
  try {
    // 多类型模式：逐 part 快照到 parts/<key>/，packer 合并打包
    if (profile.parts && profile.parts.length > 0) {
      return await snapshotMultiPart(profile, secrets, stagingDir)
    }
    switch (profile.kind) {
      case 'sqlite':
        return await snapshotSqlite(profile, stagingDir)
      case 'mariadb':
        return await snapshotMariadb(profile, secrets, stagingDir)
      case 'postgres':
        return await snapshotPostgres(profile, stagingDir)
      case 'directory':
      case 'config':
        return await snapshotDirectory(profile, stagingDir)
      default: {
        const never: never = profile.kind
        throw new ExecutorError(`unknown profile kind: ${never as string}`, profile.id)
      }
    }
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    if (err instanceof ExecutorError) throw err
    const stderr = err instanceof Error && 'stderr' in err ? String((err as { stderr?: unknown }).stderr) : undefined
    throw new ExecutorError(`snapshot failed: ${err instanceof Error ? err.message : String(err)}`, profile.id, stderr)
  }
}

/** SQLite：better-sqlite3 内置 backup API（进程内在线一致性快照，等价 sqlite3 .backup；WAL 库安全，无需宿主 sqlite3 CLI） */
async function snapshotSqlite(profile: AppProfile, stagingDir: string): Promise<SnapshotResult> {
  if (!profile.dbPath) throw new ExecutorError('sqlite profile missing dbPath', profile.id)
  const outName = 'snapshot.db'
  const outPath = join(stagingDir, outName)
  const Database = (await import('better-sqlite3')).default
  const db = new Database(profile.dbPath, { readonly: true, fileMustExist: true })
  try {
    await db.backup(outPath)
  } finally {
    db.close()
  }
  const s = await stat(outPath)
  if (s.size === 0) throw new ExecutorError('sqlite snapshot produced empty file', profile.id)
  // 完整性验证（必过，不过=备份假成功）
  const check = new Database(outPath, { readonly: true })
  try {
    const row = check.pragma('integrity_check') as { integrity_check: string }[]
    const result = row[0]?.integrity_check ?? 'unknown'
    if (result !== 'ok') {
      throw new ExecutorError(`sqlite integrity_check failed: ${result}`, profile.id)
    }
  } finally {
    check.close()
  }
  return { stagingDir, artifactName: outName, detail: `better-sqlite3 backup + integrity_check ok (${s.size} bytes)` }
}

/**
 * MariaDB：docker exec 容器内 dump。
 * 命令名可配（mariadb:11.4 → mariadb-dump；mysql:* → mysqldump）+ command -v fallback（评审陷阱 #1）。
 * 密码走 --defaults-extra-file（评审安全审计：禁止命令行/ps 可见）。
 */
async function snapshotMariadb(profile: AppProfile, secrets: (ref: string) => string, stagingDir: string): Promise<SnapshotResult> {
  if (!profile.containers[0]) throw new ExecutorError('mariadb profile missing container', profile.id)
  if (!profile.database) throw new ExecutorError('mariadb profile missing database', profile.id)
  const container = profile.containers[0]
  const tool = profile.dumpTool ?? 'mariadb-dump'
  const workdir = profile.containerWorkdir ?? '/tmp'

  // 密码写临时 defaults 文件挂进容器（0600），命令行不带密码
  const defaultsContent = `[client]\npassword=${secrets(profile.passwordRef ?? `${profile.id}_password`)}\n`
  const defaultsName = `.my-${profile.id}-${Date.now()}.cnf`
  const hostDefaultsPath = join(stagingDir, defaultsName)
  await writeFile(hostDefaultsPath, defaultsContent, { mode: 0o600 })

  const dumpFile = `dump-${Date.now()}.sql`
  const inContainerDefaults = `${workdir}/${defaultsName}`
  const inContainerDump = `${workdir}/${dumpFile}`

  try {
    // 1) defaults 文件进容器
    await execFileAsync('docker', ['cp', hostDefaultsPath, `${container}:${inContainerDefaults}`])
    // 2) 容器内 dump（--single-transaction：InnoDB 一致性不锁业务）
    const args = (profile.dumpArgs ?? '--single-transaction --quick --routines --events').split(' ').filter(Boolean)
    const { stdout } = await execFileAsync('docker', [
      'exec',
      container,
      'sh',
      '-c',
      `DUMP_TOOL=$(command -v ${tool} || command -v mariadb-dump || command -v mysqldump); ` +
        `$DUMP_TOOL --defaults-extra-file=${inContainerDefaults} ${args.join(' ')} ${profile.database} > ${inContainerDump} && ` +
        `gzip -c ${inContainerDump}`,
    ], { maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' })
    await writeFile(join(stagingDir, 'snapshot.sql.gz'), stdout as unknown as Buffer)
    // 3) 清理容器内临时文件（defaults 含密码，必须删）
    await execFileAsync('docker', ['exec', container, 'rm', '-f', inContainerDefaults, inContainerDump]).catch(() => {})
    const s = await stat(join(stagingDir, 'snapshot.sql.gz'))
    if (s.size < 100) throw new ExecutorError(`mariadb dump suspiciously small (${s.size} bytes)`, profile.id)
    return {
      stagingDir,
      artifactName: 'snapshot.sql.gz',
      detail: `${tool} --single-transaction ${profile.database} (${s.size} bytes gz)`,
    }
  } finally {
    await rm(hostDefaultsPath, { force: true }).catch(() => {})
    await execFileAsync('docker', ['exec', container, 'rm', '-f', inContainerDefaults, inContainerDump]).catch(() => {})
  }
}

/** Postgres：docker exec pg_dump -Fc（MVCC 在线一致性）；用户名取 profile.dbUser 或容器 env 推断 */
async function snapshotPostgres(profile: AppProfile, stagingDir: string): Promise<SnapshotResult> {
  const container = profile.containers[0]
  if (!container) throw new ExecutorError('postgres profile missing container', profile.id)
  const db = profile.database ?? 'postgres'
  // pg_dump 默认用 OS 用户名（root 不存在于容器内），显式 -U
  const user = profile.dbUser ?? 'postgres'
  const dumpFile = `dump-${Date.now()}.dump`
  const inContainer = `/tmp/${dumpFile}`
  try {
    await execFileAsync('docker', ['exec', container, 'pg_dump', '-U', user, '-Fc', '-d', db, '-f', inContainer])
    const { stdout } = await execFileAsync('docker', ['exec', container, 'cat', inContainer], {
      maxBuffer: 512 * 1024 * 1024,
      encoding: 'buffer',
    })
    await writeFile(join(stagingDir, 'snapshot.dump'), stdout as unknown as Buffer)
    await execFileAsync('docker', ['exec', container, 'rm', '-f', inContainer]).catch(() => {})
    const s = await stat(join(stagingDir, 'snapshot.dump'))
    if (s.size < 100) throw new ExecutorError(`pg_dump suspiciously small (${s.size} bytes)`, profile.id)
    return { stagingDir, artifactName: 'snapshot.dump', detail: `pg_dump -Fc ${db} (${s.size} bytes)` }
  } finally {
    await execFileAsync('docker', ['exec', container, 'rm', '-f', inContainer]).catch(() => {})
  }
}

/** 目录/配置类：宿主 tar（M1 阶段直接列文件清单，打包由 packer 做 tar.gz） */
async function snapshotDirectory(profile: AppProfile, stagingDir: string): Promise<SnapshotResult> {
  if (profile.paths.length === 0) throw new ExecutorError('directory profile missing paths', profile.id)
  // 校验路径存在（fail fast：路径错了备份是假的）
  for (const p of profile.paths) {
    try {
      await stat(p)
    } catch {
      throw new ExecutorError(`path not accessible: ${p}`, profile.id)
    }
  }
  const { writeFile: wf2 } = await import('node:fs/promises')
  await wf2(join(stagingDir, 'sources.json'), JSON.stringify(profile.paths, null, 2))
  return {
    stagingDir,
    artifactName: 'sources.json',
    detail: `paths: ${profile.paths.join(', ')} (packed by packer)`,
  }
}

export { tmpdir }

/** part 专用 AppProfile 视图（复用单类型执行器） */
function partToProfile(profile: AppProfile, part: ProfilePart): AppProfile {
  return {
    ...profile,
    id: profile.id,
    kind: part.kind,
    paths: part.paths ?? [],
    containers: part.container ? [part.container] : [],
    dbPath: part.dbPath,
    database: part.database,
    dbUser: part.dbUser,
    dumpTool: part.dumpTool,
    dumpArgs: part.dumpArgs,
    passwordRef: part.passwordRef,
    containerWorkdir: part.containerWorkdir,
  }
}

/**
 * 多类型快照：每个 part 用对应一致性执行器，产物统一放 staging/parts/<key>/。
 * 单个 part 失败 → 整体失败（备份的完整性优先，避免「以为备好了其实缺一半」）。
 */
async function snapshotMultiPart(profile: AppProfile, secrets: (ref: string) => string, stagingDir: string): Promise<SnapshotResult> {
  const partsRoot = join(stagingDir, 'parts')
  const { mkdir } = await import('node:fs/promises')
  const details: string[] = []
  const partResults: { key: string; kind: ProfileKind; label: string }[] = []
  const partList = profile.parts ?? []
  for (let i = 0; i < partList.length; i++) {
    const part = partList[i]
    if (!part) continue
    const key = partKey(part, i)
    const partDir = join(partsRoot, key)
    await mkdir(partDir, { recursive: true })
    const sub = partToProfile(profile, part)
    const snap = await takeSnapshotSingle(sub, secrets, partDir)
    details.push(`[${part.label}] ${snap.detail}`)
    partResults.push({ key, kind: part.kind, label: part.label })
  }
  return {
    stagingDir,
    artifactName: 'parts/',
    detail: `多类型打包 ${partResults.length} 项：${details.join('；')}`,
  }
}

/** 单类型快照（供 multipart 复用；不建 temp staging，直接用指定目录） */
async function takeSnapshotSingle(profile: AppProfile, secrets: (ref: string) => string, stagingDir: string): Promise<SnapshotResult> {
  switch (profile.kind) {
    case 'sqlite':
      return await snapshotSqlite(profile, stagingDir)
    case 'mariadb':
      return await snapshotMariadb(profile, secrets, stagingDir)
    case 'postgres':
      return await snapshotPostgres(profile, stagingDir)
    case 'directory':
    case 'config':
      return await snapshotDirectory(profile, stagingDir)
    default: {
      const never: never = profile.kind
      throw new ExecutorError(`unknown profile kind: ${never as string}`, profile.id)
    }
  }
}

function partKey(part: ProfilePart, idx: number): string {
  const n = (part.label ?? '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-').slice(0, 20)
  return `${idx}_${part.kind}_${n || 'part'}`
}
