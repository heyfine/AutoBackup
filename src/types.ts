/** 核心类型定义（前后端单一来源） */

/** 档案类型（一致性执行器种类） */
export type ProfileKind = 'sqlite' | 'mariadb' | 'postgres' | 'directory' | 'config'

/** 一致性等级 */
export type ConsistencyLevel = 'consistent' | 'best_effort' | 'stop_service'

/** 备份档案（一个可备份单元） */
export interface AppProfile {
  id: string
  name: string
  kind: ProfileKind
  /** 目录类：要打包的宿主路径 */
  paths: string[]
  /** 数据库类：容器名（docker exec 用），目录类可选（stop_service 时逐个 stop/start） */
  containers: string[]
  /** sqlite 类：容器内或宿主的 db 文件路径 */
  dbPath?: string
  /** mariadb/postgres：dump 命令（mariadb:* → mariadb-dump），可配 */
  dumpTool?: string
  dumpArgs?: string
  /** mariadb：库名；pg：库名 */
  database?: string
  /** pg：连接用户（容器内 OS 用户≠DB 用户时必填，如 litellm 的 llmproxy） */
  dbUser?: string
  /** mariadb：凭据在 secrets.env 的引用键 */
  passwordRef?: string
  /** 容器内工作路径（dump 临时文件） */
  containerWorkdir?: string
  /** 敏感档案默认加密 */
  encrypt: boolean
  /** 一致性等级声明 */
  consistency: ConsistencyLevel
  /** 每日执行时刻（ HH:mm，错峰用），空=跟随默认批次 */
  scheduleAt?: string
  enabled: boolean
  /** detector 出的草稿标记，确认后置 false */
  isDraft: boolean
}

/** WebDAV 目标 */
export interface BackupTarget {
  id: string
  name: string
  url: string
  username: string
  /** secrets.env 引用键；不存明文 */
  passwordRef: string
  enabled: boolean
  /** 自定义保留份数（覆盖全局） */
  keep: number
  /** 容量水位百分比（如 85 = 85% 配额触发裁剪） */
  capacityQuotaMb?: number
  capacityWarnPct: number
  /** 上传超时分钟 */
  timeoutMin: number
}

/** 一次备份执行记录 */
export interface RunRecord {
  id: string
  profileId: string
  trigger: 'schedule' | 'manual' | 'retry'
  status: 'running' | 'success' | 'failed' | 'skipped'
  stage: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  /** 本地 artifact 路径（含扩展名 .tar.gz 或 .tar.gz.age） */
  localPath?: string
  sizeBytes?: number
  sha256?: string
  encrypted: boolean
  /** 每目标推送结果 JSON 数组 */
  pushes: PushRecord[]
  error?: string
}

export interface PushRecord {
  targetId: string
  status: 'pending' | 'ok' | 'failed'
  attempts: number
  remotePath?: string
  bytesSent?: number
  error?: string
}

/** manifest：打进包外的清单位件（永不加密） */
export interface Manifest {
  manifest_version: 1
  tool_version: string
  profile_id: string
  profile_name: string
  kind: ProfileKind
  /** 快照完成时刻（数据截止点，唯一可信） */
  snapshot_at: string
  created_at: string
  compression: 'gzip'
  encryption: 'age' | 'none'
  size_bytes: number
  sha256: string
  /** 包内文件清单 */
  files: { name: string; size: number; sha256: string }[]
  /** 容器镜像 digest（重建复现用） */
  image_digests: Record<string, string>
  restore_hint: string
}

/** detector 草稿 */
export interface DetectedDraft {
  containerName: string
  image: string
  mounts: { type: 'bind' | 'volume'; source: string; dest: string }[]
  suggestedProfile: Partial<AppProfile>
  confidence: 'high' | 'low'
}

/** 通知事件 */
export type NotifyEvent =
  | 'backup_failed'
  | 'backup_recovered'
  | 'quota_pruned'
  | 'auth_failed'
  | 'consecutive_failures'
