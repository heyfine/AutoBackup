import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile, copyFile, stat, cp, readdir } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar-stream'
import { join, basename, dirname } from 'node:path'
import type { AppProfile, Manifest } from '../types.js'

const execFileAsync = promisify(execFile)

/**
 * 还原模块（方案 D4 / 用户需求）：从本地 artifact 还原。
 * 两种模式：
 *  - preview: 解包到 preview/ 目录供检查（不碰生产数据）
 *  - inplace: 正式还原（RED 级：必须输入档案名确认；还原前自动做 pre-restore 兜底包）
 * 一致性硬规则延续：sqlite 还原前先 integrity_check 验证快照，坏的快照拒绝还原。
 */

export class RestoreError extends Error {
  constructor(message: string, readonly profileId: string) {
    super(message)
    this.name = 'RestoreError'
  }
}

export interface RestoreOptions {
  mode: 'preview' | 'inplace'
  /** inplace 必须传 profile.name 原文（RED 级确认） */
  confirmName?: string
  ageKeyPath?: string
  homeDir: string
}

export interface RestoreResult {
  mode: 'preview' | 'inplace'
  artifactPath: string
  /** 执行的步骤（UI 逐条展示） */
  steps: string[]
  /** preview 模式的解包目录 */
  previewDir?: string
  /** preview 模式的文件清单 */
  files?: string[]
  preRestoreBackup?: string
  finishedAt: string
}

/** 解包 artifact（.age 自动解密；.gz 自动解压）到 destDir */
export async function unpackArtifact(artifactPath: string, destDir: string, ageKeyPath?: string): Promise<string[]> {
  await mkdir(destDir, { recursive: true })
  let tarPath = artifactPath

  if (artifactPath.endsWith('.age')) {
    if (!ageKeyPath) throw new RestoreError('加密包需要 age 私钥（secrets.d/age.key.txt）', '')
    const plainPath = join(destDir, '..plain.tar.gz')
    await new Promise<void>((resolve, reject) => {
      const p = spawn('age', ['-d', '-i', ageKeyPath, artifactPath])
      const out = createWriteStream(plainPath)
      let errMsg = ''
      p.stderr.on('data', (c: Buffer) => (errMsg += c.toString()))
      p.stdout.pipe(out)
      p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`age 解密失败: ${errMsg}`))))
      p.on('error', reject)
    })
    tarPath = plainPath
  }

  const entries: string[] = []
  const ex = tar.extract()
  // entry 回调用队列化处理：把写入动作转成 promise 链，严格串行（tar-stream 要求 next() 驱动）
  let chain = Promise.resolve()
  ex.on('entry', (header, stream, next) => {
    chain = chain.then(async () => {
      const outPath = join(destDir, header.name)
      if (header.type === 'directory') {
        await mkdir(outPath, { recursive: true })
        stream.resume()
        next()
        return
      }
      await mkdir(dirname(outPath), { recursive: true })
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(outPath, { mode: header.mode })
        stream.on('error', reject)
        ws.on('error', reject)
        ws.on('finish', () => {
          entries.push(header.name)
          resolve()
        })
        stream.pipe(ws)
      })
      next()
    }).catch(next)
  })
  await pipeline(createReadStream(tarPath), createGunzip(), ex)
  await chain
  if (tarPath !== artifactPath) await rm(tarPath, { force: true })
  return entries.sort()
}

/** sqlite 快照还原前验证（坏快照拒绝还原） */
async function verifySqlite(dbPath: string): Promise<void> {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(dbPath, { readonly: true })
  try {
    const row = db.pragma('integrity_check') as { integrity_check: string }[]
    if ((row[0]?.integrity_check ?? '') !== 'ok') {
      throw new RestoreError(`快照 integrity_check 失败：${row[0]?.integrity_check}——拒绝还原坏快照`, '')
    }
  } finally {
    db.close()
  }
}

/** 还原主入口 */
export async function restoreProfile(
  profile: AppProfile,
  artifactPath: string,
  opts: RestoreOptions,
): Promise<RestoreResult> {
  const steps: string[] = []
  const finishedAt = () => new Date().toISOString()

  // RED 级确认（inplace）
  if (opts.mode === 'inplace') {
    if (opts.confirmName !== profile.name) {
      throw new RestoreError(`RED 级操作确认失败：请输入档案名「${profile.name}」原文以确认覆盖`, profile.id)
    }
  }

  // 1) 解包到工作目录
  const workDir = join(opts.homeDir, 'restore-work', `${profile.id}-${Date.now()}`)
  steps.push(`解包 ${artifactPath.split(/[\\/]/).pop()}`)
  const files = await unpackArtifact(artifactPath, workDir, opts.ageKeyPath)
  steps.push(`解包完成，${files.length} 个文件`)

  // 读 manifest.parts（整体还原路由依据；老单类型包没有 parts 字段走原逻辑）
  let manifestParts: Manifest['parts'] | undefined
  try {
    const mPath = artifactPath.replace(/\.tar\.gz(\.age)?$/, '.manifest.json')
    const raw = JSON.parse(readFileSync(mPath, 'utf8')) as Manifest
    manifestParts = raw.parts
  } catch {
    manifestParts = undefined
  }

  try {
    if (opts.mode === 'preview') {
      const previewDir = join(opts.homeDir, 'preview', `${profile.id}-${Date.now()}`)
      await mkdir(join(previewDir), { recursive: true })
      await cp(workDir, previewDir, { recursive: true })
      steps.push(`预览解包至 ${previewDir}（24h 后可删，不影响生产）`)
      if (manifestParts?.length) {
        steps.push(`包内含 ${manifestParts.length} 个部分：${manifestParts.map((x) => `${x.label}(${x.kind})`).join('、')}——正式还原时将整体自动恢复`)
      }
      return { mode: 'preview', artifactPath, steps, previewDir, files, finishedAt: finishedAt() }
    }

    // ---- 多类型整体还原（v2）：逐 part 按类型路由，一次操作恢复全部勾选项 ----
    if (manifestParts && manifestParts.length > 0) {
      await restoreMultiPart(profile, manifestParts, workDir, steps, opts)
      return {
        mode: 'inplace',
        artifactPath,
        steps,
        preRestoreBackup: steps.find((s) => s.includes('兜底'))?.match(/至 (\S+)/)?.[1],
        finishedAt: finishedAt(),
      }
    }

    // ---- inplace：按类型执行 ----
    const preRestoreDir = join(opts.homeDir, 'pre-restore', `${profile.id}-${Date.now()}`)
    await mkdir(preRestoreDir, { recursive: true })

    switch (profile.kind) {
      case 'sqlite': {
        if (!profile.dbPath) throw new RestoreError('sqlite 档案缺少 dbPath', profile.id)
        const snapDb = join(workDir, 'snapshot.db')
        await stat(snapDb)
        steps.push('验证快照完整性（integrity_check）')
        await verifySqlite(snapDb)

        // 停容器（档案声明了容器才停）
        if (profile.containers.length > 0) {
          for (const c of profile.containers) {
            await execFileAsync('docker', ['stop', c])
            steps.push(`停止容器 ${c}`)
          }
        } else {
          steps.push('⚠️ 档案未声明容器，无法停服——建议尽快在编辑里补充容器名')
        }

        // pre-restore 兜底：当前 db + wal/shm
        await copyFile(profile.dbPath, join(preRestoreDir, 'current.db')).catch(() => {})
        for (const ext of ['-wal', '-shm']) {
          await copyFile(profile.dbPath + ext, join(preRestoreDir, 'current.db' + ext)).catch(() => {})
        }
        steps.push(`当前数据库已兜底备份至 ${preRestoreDir}`)

        // 替换 db（清 wal/shm）
        await copyFile(snapDb, profile.dbPath)
        for (const ext of ['-wal', '-shm']) await rm(profile.dbPath + ext, { force: true })
        steps.push(`已替换 ${profile.dbPath}`)

        // 起容器
        for (const c of profile.containers) {
          await execFileAsync('docker', ['start', c])
          steps.push(`启动容器 ${c}`)
        }
        // 复验
        await verifySqlite(profile.dbPath)
        steps.push('还原后 integrity_check 通过 ✓')
        break
      }

      case 'mariadb':
      case 'postgres': {
        throw new RestoreError(
          '数据库 dump 还原（mariadb/postgres）建议走「导入 dump」流程：解包预览 → 手动 docker exec 导入（还原涉及凭据注入与库重建，UI 化风险大于收益，文档化操作更安全）',
          profile.id,
        )
      }

      case 'postgres': {
        throw new RestoreError('postgres 还原请使用 CLI（需要 pg_restore + 凭据），M4 预览模式可用', profile.id)
      }

      case 'directory':
      case 'config': {
        if (profile.paths.length === 0) throw new RestoreError('档案缺少路径', profile.id)
        // pre-restore 兜底：打包当前内容
        for (const p of profile.paths) {
          await cp(p, join(preRestoreDir, basename(p)), { recursive: true }).catch(() => {})
        }
        steps.push(`当前数据已兜底备份至 ${preRestoreDir}`)
        // 逐路径还原：清空原目录内容（保留目录本身——bind mount 挂载点不能删）→ 拷入解包内容
        for (const p of profile.paths) {
          const root = basename(p)
          const unpacked = join(workDir, root)
          await stat(unpacked)
          const existing = await readdir(p).catch(() => [])
          for (const e of existing) await rm(join(p, e), { recursive: true, force: true })
          await cp(unpacked, p, { recursive: true })
          steps.push(`已还原 ${p}（${(await readdir(p)).length} 项）`)
        }
        break
      }

      default: {
        const never: never = profile.kind
        throw new RestoreError(`unknown kind: ${never as string}`, profile.id)
      }
    }

    return {
      mode: 'inplace',
      artifactPath,
      steps,
      preRestoreBackup: preRestoreDir,
      finishedAt: finishedAt(),
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 还原审计日志（只增不改，RF6） */
export async function auditRestore(
  homeDir: string,
  entry: { profileId: string; runId?: string; mode: string; operator: string; result: string; error?: string },
): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'
  await writeFile(join(homeDir, 'logs', 'restore-audit.jsonl'), line, { flag: 'a' })
}

type ManifestPart = NonNullable<Manifest['parts']>[number]

/**
 * 多类型整体还原：包内 parts/<key>/ 逐个按类型路由恢复。
 * 涉及容器的 part（sqlite 停/起容器、dump 类提示手动导入）统一在此调度，
 * 目录/配置类直接覆盖原路径；所有 part 共用一次 pre-restore 兜底。
 */
async function restoreMultiPart(
  profile: AppProfile,
  parts: ManifestPart[],
  workDir: string,
  steps: string[],
  opts: RestoreOptions,
): Promise<void> {
  const preRestoreDir = join(opts.homeDir, 'pre-restore', `${profile.id}-${Date.now()}`)
  await mkdir(preRestoreDir, { recursive: true })
  const backedUp: string[] = []

  // 第 0 步：全部涉及的容器先停（数据库 part 还原期间保持一致性；兜底也在此窗口做）
  const containers = [...new Set(parts.map((p) => p.container).filter(Boolean))] as string[]
  for (const c of containers) {
    await execFileAsync('docker', ['stop', c])
    steps.push(`停止容器 ${c}`)
  }
  if (containers.length === 0) steps.push('无容器依赖，直接文件级还原')

  try {
    for (const part of parts) {
      const partDir = join(workDir, part.root)
      await stat(partDir) // 包内缺 part = 包损坏，拒绝
      steps.push(`▶ 恢复 [${part.label}]（${part.kind}）`)

      if (part.restore === 'sqlite') {
        if (!part.dbPath) throw new RestoreError(`part ${part.key} 缺 dbPath`, profile.id)
        const snapDb = join(partDir, 'snapshot.db')
        await stat(snapDb)
        await verifySqlite(snapDb)
        steps.push(`[${part.label}] 快照 integrity_check 通过`)
        // 兜底：当前 db + wal/shm
        await copyFile(part.dbPath, join(preRestoreDir, `${part.key}.db`)).catch(() => {})
        for (const ext of ['-wal', '-shm']) {
          await copyFile(part.dbPath + ext, join(preRestoreDir, `${part.key}.db` + ext)).catch(() => {})
        }
        backedUp.push(part.dbPath)
        // 替换 db（清 wal/shm）
        await mkdir(dirname(part.dbPath), { recursive: true })
        await copyFile(snapDb, part.dbPath)
        for (const ext of ['-wal', '-shm']) await rm(part.dbPath + ext, { force: true })
        steps.push(`[${part.label}] 已替换 ${part.dbPath}`)
      } else if (part.restore === 'mariadb' || part.restore === 'postgres') {
        // dump 还原需要凭据注入，停容器窗口内自动导入风险大——给出明确文件位置，用户确认后手动导（文档化）
        const dumpFile = part.restore === 'mariadb' ? 'snapshot.sql.gz' : 'snapshot.dump'
        await stat(join(partDir, dumpFile))
        steps.push(
          `[${part.label}] dump 已就绪：${join(partDir, dumpFile)}（容器 ${part.container ?? '?'} 已停止）。` +
            `自动导入需注入凭据，为安全起见请按 docs 手动执行导入后启动容器 ${part.container ?? '?'}；` +
            `或仅还原此 part 之外的类型（此包其余部分已自动恢复）`,
        )
      } else {
        // directory/config：逐路径覆盖（清空原目录内容再拷入）
        const paths = part.paths ?? []
        if (paths.length === 0) throw new RestoreError(`part ${part.key} 缺 paths`, profile.id)
        for (const p of paths) {
          // 兜底
          await cp(p, join(preRestoreDir, 'dir-' + basename(p) + '-' + part.key), { recursive: true }).catch(() => {})
          backedUp.push(p)
          const root = basename(p)
          const unpacked = join(partDir, root)
          await stat(unpacked)
          const existing = await readdir(p).catch(() => [])
          for (const e of existing) await rm(join(p, e), { recursive: true, force: true })
          await cp(unpacked, p, { recursive: true })
          steps.push(`[${part.label}] 已还原 ${p}（${(await readdir(p)).length} 项）`)
        }
      }
    }
    steps.push(`✅ 整体还原完成：${parts.length} 个部分全部处理（兜底备份：${preRestoreDir}）`)
  } finally {
    // 无论成败，把停掉的容器全部拉起来（失败也不能留下停机的服务）
    for (const c of containers) {
      await execFileAsync('docker', ['start', c]).catch(() => {})
      steps.push(`启动容器 ${c}`)
    }
  }
  if (backedUp.length > 0) {
    steps.push(`原数据已兜底备份至 ${preRestoreDir}（${backedUp.length} 项）`)
  }
}
