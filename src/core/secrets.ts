import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
/**
 * secrets.env 加载：KEY=VALUE 行格式，# 注释。
 * 文件权限 0600 由部署脚本保证（Windows 开发环境不检查）。
 * Profile 通过 passwordRef 引用键名，不持有明文。
 */
export class Secrets {
  private values = new Map<string, string>()

  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) {
      throw new Error(`secrets file not found: ${filePath}`)
    }
    const raw = readFileSync(filePath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      // 去成对引号
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      this.values.set(key, value)
    }
  }

  /** 取凭据值；缺失时抛错（fail fast，不静默跳过） */
  get(ref: string): string {
    const v = this.values.get(ref)
    if (v === undefined || v === '') {
      throw new Error(`secrets key not found: ${ref} (file: ${this.filePath})`)
    }
    return v
  }

  getOptional(ref: string): string | undefined {
    const v = this.values.get(ref)
    return v === undefined || v === '' ? undefined : v
  }

  has(ref: string): boolean {
    const v = this.values.get(ref)
    return v !== undefined && v !== ''
  }
}

/** 默认 secrets 路径解析：环境变量 > 工作目录 */
export function resolveSecretsPath(configDir?: string): string {
  if (process.env.AUTOBACKUP_SECRETS) return process.env.AUTOBACKUP_SECRETS
  const dir = configDir ?? process.env.AUTOBACKUP_HOME ?? process.cwd()
  return join(dir, 'secrets.env')
}
