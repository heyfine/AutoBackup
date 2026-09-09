import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, writeFile, copyFile, stat, cp, readdir } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar-stream'
import { join, basename, dirname } from 'node:path'
import type { AppProfile } from '../types.js'

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

  try {
    if (opts.mode === 'preview') {
      const previewDir = join(opts.homeDir, 'preview', `${profile.id}-${Date.now()}`)
      await mkdir(join(previewDir), { recursive: true })
      await cp(workDir, previewDir, { recursive: true })
      steps.push(`预览解包至 ${previewDir}（24h 后可删，不影响生产）`)
      return { mode: 'preview', artifactPath, steps, previewDir, files, finishedAt: finishedAt() }
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
