/** 核心类型定义（前后端单一来源） */

/** 档案类型（一致性执行器种类） */
export type ProfileKind = 'sqlite' | 'mariadb' | 'postgres' | 'directory' | 'config'

/** 一致性等级 */
export type ConsistencyLevel = 'consistent' | 'best_effort' | 'stop_service'

/** 备份频率：每天固定时刻 或 每隔 N 小时 */
export type ScheduleSpec =
  | { mode: 'daily'; at: string } // "HH:mm"
  | { mode: 'interval'; hours: number } // 1-168

/** 多类型备份子项（v2）：一个档案可勾选多种内容合并打包 */
export interface ProfilePart {
  /** 子项类型（决定一致性执行器与还原方式） */
  kind: ProfileKind
  /** 显示名（如「数据库」「配置文件」） */
  label: string
  /** 目录/配置类：宿主路径 */
  paths?: string[]
  /** 数据库类：容器名 */
  container?: string
  /** sqlite：db 文件路径 */
  dbPath?: string
  database?: string
  dbUser?: string
  dumpTool?: string
  dumpArgs?: string
  passwordRef?: string
  containerWorkdir?: string
  /** 探测到的字节大小（UI 展示；执行时刷新） */
  sizeBytes?: number
}

/** 备份档案（一个可备份单元） */
export interface AppProfile {
  id: string
  name: string
  kind: ProfileKind
  /** 多类型备份（v2）：勾选的备份内容列表；为空时回退到单类型字段（旧档案兼容） */
  parts?: ProfilePart[]
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
  /** 备份频率（替代旧 scheduleAt；迁移兼容：旧数据转 {mode:'daily',at}） */
  schedule: ScheduleSpec
  /** 档案绑定的 WebDAV 目标 id 列表（空 = 全部启用目标） */
  targetIds: string[]
  /** 档案级保留份数（覆盖目标默认；per-target keep 语义保留） */
  keep: number
  /** 上次备份完成时刻（ISO），调度器用它 + schedule 推算下次 */
  lastRunAt?: string
  enabled: boolean
  /** detector 出的草稿标记，确认后置 false */
  isDraft: boolean
}

/** WebDAV 目标（供应商无关；产品化：任意 WebDAV 服务器） */
export interface BackupTarget {
  id: string
  name: string
  url: string
  username: string
  /** secrets.env 引用键；不存明文 */
  passwordRef: string
  enabled: boolean
  /** 目标默认保留份数（档案未设置 keep 时用） */
  keep: number
  /** 容量水位百分比（如 85 = 85% 配额触发裁剪） */
  capacityQuotaMb?: number
  capacityWarnPct: number
  /** 上传超时分钟 */
  timeoutMin: number
  /** 是否接受未加密备份（产品化：可强制全仓库加密） */
  allowUnencrypted: boolean
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
  /** 多类型打包：包内各 part 的位置与还原方式（整体还原路由依据） */
  parts?: { key: string; kind: ProfileKind; label: string; root: string; restore: 'sqlite' | 'directory' | 'mariadb' | 'postgres'; dbPath?: string; database?: string; dbUser?: string; container?: string; dumpTool?: string; paths?: string[] }[]
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
