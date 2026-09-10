import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { ProfilePart, ProfileKind } from '../types.js'

const execFileAsync = promisify(execFile)

/**
 * 类型自动识别（v2）：给定档案上下文（容器名/路径/db 路径），探测可勾选的备份类型 + 各自大小。
 * 编辑器多选列表的数据源。
 */

export interface DetectedPart extends ProfilePart {
  /** 探测来源说明（如「容器 wp-blog-db-1 (mariadb:11.4)」） */
  source: string
  /** 不可用原因（探测到但无法备份，如路径不存在） */
  unavailable?: string
  available: boolean
}

export interface InspectResult {
  /** 可勾选的备份类型（含大小） */
  parts: DetectedPart[]
  /** 探测说明 */
  note: string
}

/** 目录大小（字节）——快速统计（跳过无权限项） */
async function dirSize(p: string): Promise<number> {
  let total = 0
  try {
    const s = await stat(p)
    if (!s.isDirectory()) return s.size
    const entries = await readdir(p, { withFileTypes: true })
    for (const e of entries) {
      total += await dirSize(join(p, e.name)).catch(() => 0)
    }
  } catch {
    return 0
  }
  return total
}

async function pathSize(p: string): Promise<number> {
  try {
    const s = await stat(p)
    return s.isDirectory() ? await dirSize(p) : s.size
  } catch {
    return -1
  }
}

/** 容器内数据库大小（docker exec du -sb；跨镜像用 sh 兜底） */
async function containerDbSize(container: string, inContainerPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('docker', ['exec', container, 'du', '-sb', inContainerPath])
    return parseInt(stdout.trim().split('\t')[0] ?? '0', 10) || 0
  } catch {
    return -1
  }
}

/**
 * 探测一个档案可备份的类型列表。
 * 输入容器名 + 已知路径（可选），输出可勾选的 part 候选。
 */
export async function inspectProfileParts(input: {
  containers?: string[]
  dbPath?: string
  /** 多个 db 候选（v2 编辑器传入已勾选 parts 的 dbPath） */
  dbPaths?: string[]
  paths?: string[]
  /** 档案名（用于推测配置目录，如 /opt/vaultwarden） */
  name?: string
}): Promise<InspectResult> {
  const parts: DetectedPart[] = []
  const notes: string[] = []
  const containers = input.containers ?? []

  for (const c of containers) {
    let image = ''
    try {
      const { stdout } = await execFileAsync('docker', ['inspect', c, '--format', '{{.Config.Image}}'])
      image = stdout.trim()
    } catch {
      parts.push({ kind: 'directory', label: `容器 ${c}`, container: c, paths: [], source: c, available: false, unavailable: '容器不存在或 docker 不可用' })
      continue
    }
    notes.push(`${c} (${image})`)

    if (/mariadb|mysql/i.test(image)) {
      const dbs = await listMariadbDatabases(c).catch(() => [])
      for (const db of dbs) {
        const size = await containerDbSize(c, `/var/lib/mysql/${db}`)
        parts.push({
          kind: 'mariadb', label: `数据库 ${db}`, container: c, database: db,
          dumpTool: /mariadb/i.test(image) ? 'mariadb-dump' : 'mysqldump',
          sizeBytes: size > 0 ? size : undefined,
          source: `容器 ${c}（${image}）`, available: true,
        })
      }
      if (dbs.length === 0) {
        parts.push({ kind: 'mariadb', label: '数据库（需填库名）', container: c, dumpTool: /mariadb/i.test(image) ? 'mariadb-dump' : 'mysqldump', source: `容器 ${c}（${image}）`, available: false, unavailable: '无法列出数据库，请手动填写库名' })
      }
    } else if (/postgres/i.test(image)) {
      const dbs = await listPgDatabases(c).catch(() => [])
      for (const db of dbs) {
        const size = await containerDbSize(c, `/var/lib/postgresql/data`)
        parts.push({
          kind: 'postgres', label: `数据库 ${db}`, container: c, database: db,
          sizeBytes: size > 0 ? size : undefined,
          source: `容器 ${c}（${image}）`, available: true,
        })
      }
      if (dbs.length === 0) {
        parts.push({ kind: 'postgres', label: '数据库（需填库名）', container: c, source: `容器 ${c}（${image}）`, available: false, unavailable: '无法列出数据库，请手动填写库名' })
      }
    } else if (/redis/i.test(image)) {
      parts.push({ kind: 'directory', label: 'Redis 数据', container: c, paths: [], source: `容器 ${c}（${image}）`, available: false, unavailable: 'Redis 建议用 bgsave 后备份 dump.rdb，暂不支持自动识别' })
    } else {
      // 通用容器：探测挂载点作为「文件/数据」候选
      const mounts = await containerMounts(c)
      if (mounts.length > 0) {
        const size = await dirSizeOfMounts(mounts)
        parts.push({
          kind: 'directory', label: '数据文件', container: c, paths: mounts,
          sizeBytes: size > 0 ? size : undefined,
          source: `容器 ${c} 挂载点（${image}）`, available: true,
        })
      } else {
        parts.push({ kind: 'directory', label: '数据文件', container: c, paths: [], source: `容器 ${c}（${image}）`, available: false, unavailable: '未发现挂载点，请手动填写路径' })
      }
    }
  }

  // sqlite db 路径（单/多候选）
  const dbCandidates = [...new Set([...(input.dbPaths ?? []), ...(input.dbPath ? [input.dbPath] : [])])].filter(Boolean) as string[]
  for (const dbp of dbCandidates) {
    const size = await pathSize(dbp)
    parts.push({
      kind: 'sqlite', label: `SQLite 数据库 ${basename(dbp)}`,
      dbPath: dbp,
      sizeBytes: size >= 0 ? size : undefined,
      source: dbp,
      available: size >= 0,
      unavailable: size < 0 ? '文件不存在或不可读' : undefined,
    })
  }

  // 目录路径（文件/配置）
  for (const p of input.paths ?? []) {
    const size = await pathSize(p)
    const isConfigLike = /config|conf|etc|\.ya?ml|\.env|nginx|compose/i.test(basename(p))
    parts.push({
      kind: isConfigLike ? 'config' : 'directory',
      label: isConfigLike ? `配置 ${basename(p)}` : `数据 ${basename(p)}`,
      paths: [p],
      sizeBytes: size >= 0 ? size : undefined,
      source: p,
      available: size >= 0,
      unavailable: size < 0 ? '路径不存在或不可读' : undefined,
    })
  }

  return { parts, note: notes.length > 0 ? `扫描容器：${notes.join('、')}` : '无容器上下文，按路径识别' }
}

async function containerMounts(container: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('docker', ['inspect', container, '--format', '{{json .Mounts}}'])
    const raw = JSON.parse(stdout) as { Type: string; Source?: string; Destination: string; Name?: string; RW?: boolean }[]
    return raw
      .filter((m) => m.Type === 'bind' && m.RW !== false && m.Source)
      .map((m) => m.Source as string)
  } catch {
    return []
  }
}

async function dirSizeOfMounts(mounts: string[]): Promise<number> {
  let total = 0
  for (const m of mounts) {
    total += await dirSize(m).catch(() => 0)
  }
  return total
}

/** mariadb 列数据库（凭据在容器 env 里，无需宿主提供） */
async function listMariadbDatabases(container: string): Promise<string[]> {
  const { stdout } = await execFileAsync('docker', ['exec', container, 'sh', '-c',
    'mysql -N -e "SHOW DATABASES" 2>/dev/null || mariadb -N -e "SHOW DATABASES" 2>/dev/null'])
  return stdout.trim().split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !/^(information_schema|performance_schema|sys|mysql)$/.test(s))
}

/** postgres 列数据库 */
async function listPgDatabases(container: string): Promise<string[]> {
  const { stdout } = await execFileAsync('docker', ['exec', container, 'sh', '-c',
    'psql -U ${POSTGRES_USER:-postgres} -N -t -c "SELECT datname FROM pg_database WHERE datistemplate = false" 2>/dev/null || psql -U postgres -N -t -c "SELECT datname FROM pg_database WHERE datistemplate = false"'])
  return stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean)
}
