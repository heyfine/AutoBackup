import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DetectedDraft } from '../types.js'

const execFileAsync = promisify(execFile)

/**
 * 容器检测器（M4，产品化）：docker.sock 轮询 → 按指纹建议档案 → 只出「草稿」，默认停用。
 * 用户在 UI 上确认/编辑后才启用（AGENTS.md 硬规则 #1：未确认绝不备份）。
 */

/** 内置指纹库：常见自托管应用（image 匹配 → 建议档案） */
const FINGERPRINTS: {
  match: RegExp
  suggest: (c: ContainerInfo, mounts: MountInfo[]) => DetectedDraft['suggestedProfile']
}[] = [
  {
    match: /vaultwarden/i,
    suggest: (c, mounts) => ({
      name: 'Vaultwarden 数据',
      kind: 'sqlite',
      paths: [],
      dbPath: mountToHostPath(mounts, '/data') + '/db.sqlite3',
      encrypt: true,
      consistency: 'consistent',
    }),
  },
  {
    match: /wordpress/i,
    suggest: (c, mounts) => ({
      name: 'WordPress 文件',
      kind: 'directory',
      paths: mountToHostPaths(mounts, '/var/www/html'),
      containers: [c.name],
      encrypt: false,
      consistency: 'best_effort',
    }),
  },
  {
    match: /mariadb|mysql/i,
    suggest: (c, _mounts) => ({
      name: 'MySQL/MariaDB 数据库',
      kind: 'mariadb',
      paths: [],
      containers: [c.name],
      dumpTool: /mariadb/i.test(c.image) ? 'mariadb-dump' : 'mysqldump',
      database: '需要你填写库名',
      encrypt: false,
      consistency: 'consistent',
    }),
  },
  {
    match: /postgres/i,
    suggest: (c) => ({
      name: 'PostgreSQL 数据库',
      kind: 'postgres',
      paths: [],
      containers: [c.name],
      dumpTool: 'pg_dump',
      database: '需要你填写库名',
      encrypt: false,
      consistency: 'consistent',
    }),
  },
  {
    match: /redis/i,
    suggest: (c) => ({
      name: 'Redis 数据',
      kind: 'directory',
      paths: [],
      containers: [c.name],
      encrypt: false,
      consistency: 'stop_service',
    }),
  },
]

interface MountInfo {
  type: string
  source: string
  dest: string
}
interface ContainerInfo {
  name: string
  image: string
  mounts: MountInfo[]
}

function mountToHostPath(mounts: MountInfo[], containerPath: string): string {
  const m = mounts.find((x) => x.dest === containerPath)
  return m?.source ?? ''
}
function mountToHostPaths(mounts: MountInfo[], containerPath: string): string[] {
  const p = mountToHostPath(mounts, containerPath)
  return p ? [p] : []
}

export interface DetectResult {
  drafts: DetectedDraft[]
  scanned: number
}

/** 扫描 docker 容器，产出「新应用」草稿（排除已有档案覆盖的容器） */
export async function detectContainers(existingContainers: string[]): Promise<DetectResult> {
  const { stdout } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}'])
  const lines = stdout.trim().split('\n').filter(Boolean)
  const drafts: DetectedDraft[] = []
  let scanned = 0

  for (const line of lines) {
    const [name, image] = line.split('\t')
    if (!name || !image) continue
    scanned++
    // 已被现有档案覆盖的容器跳过
    if (existingContainers.includes(name)) continue

    let mounts: MountInfo[] = []
    try {
      const insp = await execFileAsync('docker', ['inspect', name, '--format', '{{json .Mounts}}'])
      const raw = JSON.parse(insp.stdout) as { Type: string; Source?: string; Destination: string; Name?: string }[]
      mounts = raw.map((m) => ({
        type: m.Type,
        source: m.Source ?? (m.Name ? `/var/lib/docker/volumes/${m.Name}/_data` : ''),
        dest: m.Destination,
      }))
    } catch {
      continue
    }

    // 指纹匹配
    for (const fp of FINGERPRINTS) {
      if (fp.match.test(image)) {
        const suggested = fp.suggest({ name, image, mounts }, mounts)
        drafts.push({
          containerName: name,
          image,
          mounts: mounts.map((m) => ({ type: m.type as 'bind' | 'volume', source: m.source, dest: m.dest })),
          suggestedProfile: {
            ...suggested,
            containers: suggested.containers ?? [name],
          },
          confidence: 'high',
        })
        break // 每容器只出一条建议
      }
    }
  }
  return { drafts, scanned }
}
