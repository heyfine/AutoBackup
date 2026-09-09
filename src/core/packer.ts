import { createWriteStream, createReadStream } from 'node:fs'
import { readdir, stat, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { join, basename } from 'node:path'
import * as tar from 'tar-stream'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AppProfile, Manifest } from '../types.js'

const execFileAsync = promisify(execFile)

export const TOOL_VERSION = '0.1.0'

export interface PackResult {
  /** 最终 artifact 路径（.tar.gz 或 .tar.gz.age） */
  artifactPath: string
  sizeBytes: number
  sha256: string
  manifest: Manifest
  /** manifest 单文件路径（永不加密，随包上传） */
  manifestPath: string
}

/**
 * 打包器：stagingDir → tar.gz（node:zlib gzip，零外部依赖决策见 AGENTS.md）→ 可选 age 加密 → manifest。
 * manifest 记录 snapshot_at（数据截止点）+ sha256 + 镜像 digest。
 */
export async function pack(
  profile: AppProfile,
  stagingDir: string,
  opts: { homeDir: string; snapshotAt: string; ageRecipient?: string },
): Promise<PackResult> {
  const stamp = opts.snapshotAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  const baseName = `${profile.id}_${stamp}`
  const tarGzPath = join(opts.homeDir, `${baseName}.tar.gz`)
  const finalPath = opts.ageRecipient ? `${tarGzPath}.age` : tarGzPath

  // 1) 收集要打包的内容（目录类用 profile.paths，其他类用 stagingDir 里的产物）
  const sources: { absPath: string; arcname: string }[] = []
  if (profile.kind === 'directory' || profile.kind === 'config') {
    for (const p of profile.paths) {
      const s = await stat(p)
      if (s.isDirectory()) {
        // arcname 以「路径末段」为根（如 /opt/wp-blog/wordpress → wordpress/...），还原时释放到相对目录
        const rootName = basename(p)
        await collectDir(p, rootName, sources)
      } else {
        sources.push({ absPath: p, arcname: basename(p) })
      }
    }
  } else {
    await collectDir(stagingDir, '', sources)
  }

  // 2) tar.gz 流式打包
  await tarFiles(sources, tarGzPath)

  // 3) 可选 age 加密（shell out；敏感档案默认开）
  if (opts.ageRecipient) {
    await execFileAsync('age', ['-r', opts.ageRecipient, '-o', finalPath, tarGzPath])
    await rm(tarGzPath, { force: true }) // 明文中间产物立即删除
  }

  // 4) 校验和与 manifest
  const size = (await stat(finalPath)).size
  const sha256 = await fileSha256(finalPath)
  const manifest: Manifest = {
    manifest_version: 1,
    tool_version: TOOL_VERSION,
    profile_id: profile.id,
    profile_name: profile.name,
    kind: profile.kind,
    snapshot_at: opts.snapshotAt,
    created_at: new Date().toISOString(),
    compression: 'gzip',
    encryption: opts.ageRecipient ? 'age' : 'none',
    size_bytes: size,
    sha256,
    files: sources.slice(0, 100).map((s) => ({ name: s.arcname, size: 0, sha256: '' })), // 顶层清单（截断保护）
    image_digests: {},
    restore_hint: restoreHint(profile),
  }
  const manifestPath = join(opts.homeDir, `${baseName}.manifest.json`)
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  return { artifactPath: finalPath, sizeBytes: size, sha256, manifest, manifestPath }
}

async function collectDir(root: string, relBase: string, out: { absPath: string; arcname: string }[]): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const e of entries) {
    const abs = join(root, e.name)
    // arcname 必须是相对路径（tar 绝对路径会在还原时释放到错误位置）
    const arc = relBase === '' ? e.name : `${relBase}/${e.name}`
    if (e.isDirectory()) {
      await collectDir(abs, arc, out)
    } else {
      out.push({ absPath: abs, arcname: arc })
    }
  }
}

async function tarFiles(files: { absPath: string; arcname: string }[], outPath: string): Promise<void> {
  const pack = tar.pack()
  const gzip = createGzip({ level: 6 })
  const out = createWriteStream(outPath)
  const done = pipeline(pack, gzip, out)

  for (const f of files) {
    const s = await stat(f.absPath)
    const header = { name: f.arcname, size: s.size, mode: s.mode, mtime: s.mtime }
    await new Promise<void>((resolve, reject) => {
      const entry = pack.entry(header, (err) => (err ? reject(err) : resolve()))
      createReadStream(f.absPath)
        .pipe(entry)
        .on('error', reject)
    })
  }
  pack.finalize()
  await done
}

export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

function restoreHint(p: AppProfile): string {
  switch (p.kind) {
    case 'sqlite':
      return '停容器 → 解包替换 db（删除 -wal/-shm）→ 起容器 → /alive 探活'
    case 'mariadb':
      return `解包 snapshot.sql.gz → docker exec 容器 mariadb < dump（数据库 ${p.database ?? '?'}}）`
    case 'postgres':
      return `解包 snapshot.dump → docker exec pg_restore -d ${p.database ?? '?'}`
    case 'directory':
    case 'config':
      return `解包覆盖到原路径（先做 pre-restore 兜底包）：${p.paths.join(', ')}`
    default:
      return 'unknown'
  }
}
