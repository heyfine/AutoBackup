import { createReadStream, type ReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { setDefaultAutoSelectFamily } from 'node:net'
import type { ReadableStream as NodeWebReadable } from 'node:stream/web'

// 新服务器无 IPv6 路由；Node 22 默认 autoSelectFamily 会先试 AAAA 的 IPv6 连接，
// 黑洞网络导致 fetch/https 全部 ETIMEDOUT（curl 有独立回退不受影响）。
// 禁用地址族自动选择后按系统顺序走 IPv4，WebDAV 连接恢复。必须在任何出站连接前设置。
setDefaultAutoSelectFamily(false)

/**
 * WebDAV 客户端（语义继承 sales record webdav.ts 实测经验 + 流式改造）：
 * - 逐层 MKCOL（201/405/409 视为成功）
 * - PROPFIND Depth 0/1 测试连接与列目录
 * - 流式 PUT（ReadStream body，不整包进内存——评审决策）
 * - DELETE 尽力而为
 * - 401/403 归因认证失败；上传统一超时（AbortSignal）
 */

export class WebdavError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: 'auth' | 'connect' | 'server' = 'server',
  ) {
    super(message)
    this.name = 'WebdavError'
  }
}

export interface WebdavCreds {
  url: string
  username: string
  password: string
}

/** 递归解包 undici fetch 错误链，取最底层 cause（含 code 的网络错误） */
function findRootCause(err: unknown): unknown {
  let cur: unknown = err
  const seen = new Set<unknown>()
  while (cur && typeof cur === 'object' && 'cause' in cur && !seen.has(cur)) {
    seen.add(cur)
    cur = (cur as { cause?: unknown }).cause
  }
  return cur
}

/** 把 fetch/网络层错误翻译成用户可读的中文原因 */
export function explainFetchError(err: unknown): string {
  const root = findRootCause(err)
  const code = (root as NodeJS.ErrnoException | undefined)?.code ?? ''
  const msg = root instanceof Error ? root.message : String(root)
  switch (code) {
    case 'ENOTFOUND':
      return '无法连接：域名解析失败（DNS 找不到该服务器），请检查 WebDAV 地址是否正确'
    case 'ECONNREFUSED':
      return '无法连接：服务器拒绝连接（地址或端口错误，或对方服务未启动）'
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return '连接超时：服务器无响应（网络不稳定、被防火墙拦截或服务器过慢）'
    case 'ECONNRESET':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
      return '连接被中断：网络不稳定或服务器主动断开了连接'
    case 'CERT_HAS_EXPIRED':
      return 'SSL 证书已过期，连接被安全策略拒绝'
    default:
      if (/certificate|CERT_|SELF_SIGNED/i.test(msg)) {
        return 'SSL 证书校验失败（自签名或无效证书），连接被拒绝'
      }
      return '无法连接服务器（网络不可达），请检查网络与 WebDAV 地址'
  }
}

/** HTTP 状态码 → 中文说明（认证类错误有独立分支，这里覆盖其余常见状态） */
export function httpStatusText(status: number): string {
  switch (status) {
    case 404:
      return '路径不存在（HTTP 404），请检查 WebDAV 地址是否包含正确的子目录'
    case 405:
      return '服务器不支持该操作（HTTP 405），可能未启用 WebDAV'
    case 409:
      return '目录冲突（HTTP 409），请稍后重试'
    case 423:
      return '目录被锁定（HTTP 423），请稍后重试'
    case 429:
      return '请求过于频繁（HTTP 429），被服务器限速，请稍后重试'
    case 507:
      return '存储空间不足（HTTP 507），目标配额已满，请清理旧备份或扩容'
    case 500:
      return '目标服务器内部错误（HTTP 500），请稍后重试'
    case 502:
    case 503:
    case 504:
      return `目标服务器异常或维护中（HTTP ${status}），请稍后重试`
    default:
      return `目标服务器返回异常状态 HTTP ${status}`
  }
}

function authHeader(c: WebdavCreds): string {
  const raw = `${c.username}:${c.password}`
  // btoa 需 latin1；用 Buffer 处理 UTF-8（评审参考实现的 TextEncoder 语义）
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
}

function joinUrl(base: string, name?: string): string {
  const normalized = base.endsWith('/') ? base : `${base}/`
  return name ? `${normalized}${encodeURIComponent(name)}` : normalized
}

/** 逐层 MKCOL 自动建目录（坚果云/Koofr 均需） */
export async function mkdirp(c: WebdavCreds, signal?: AbortSignal): Promise<void> {
  const u = new URL(c.url)
  const segments = u.pathname.split('/').filter(Boolean)
  let prefix = ''
  for (const seg of segments) {
    prefix += `/${seg}`
    const res = await fetch(`${u.origin}${prefix}/`, {
      method: 'MKCOL',
      headers: { Authorization: authHeader(c) },
      signal,
    }).catch((err: unknown) => {
      throw new WebdavError(explainFetchError(err), undefined, 'connect')
    })
    if (res.status === 401 || res.status === 403) {
      throw new WebdavError('认证失败，请检查 WebDAV 用户名/密码（应用专用密码）', res.status, 'auth')
    }
    if (res.status !== 201 && res.status !== 405 && res.status !== 409) {
      throw new WebdavError(httpStatusText(res.status), res.status)
    }
  }
}

/** 测试连接：mkdirp + PROPFIND Depth 0 */
export async function testConnection(c: WebdavCreds, timeoutMs = 15000): Promise<{ ok: boolean; message: string; detail?: string }> {
  try {
    await mkdirp(c)
    const res = await fetch(joinUrl(c.url), {
      method: 'PROPFIND',
      headers: {
        Authorization: authHeader(c),
        Depth: '0',
        'Content-Type': 'application/xml',
      },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 207 || (res.status >= 200 && res.status < 300)) {
      return { ok: true, message: '连接成功（可写、可列）' }
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: '认证失败，请检查用户名/密码（WebDAV 应用专用密码）' }
    }
    return { ok: false, message: httpStatusText(res.status) }
  } catch (err) {
    if (err instanceof WebdavError) return { ok: false, message: err.message }
    return { ok: false, message: explainFetchError(err) }
  }
}

/** 流式 PUT 一个文件（ReadStream body；整体超时由 signal 控制） */
export async function putFile(
  c: WebdavCreds,
  remoteDir: string,
  fileName: string,
  localPath: string,
  opts?: { timeoutMin?: number },
): Promise<{ bytesSent: number }> {
  await mkdirp(c)
  const s = await stat(localPath)
  const timeoutMs = (opts?.timeoutMin ?? 30) * 60 * 1000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const body: ReadStream = createReadStream(localPath)
  try {
    const res = await fetch(joinUrl(remoteDir, fileName), {
      method: 'PUT',
      headers: {
        Authorization: authHeader(c),
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(s.size),
      },
      body: body as unknown as NodeWebReadable & { duplex: 'half' },
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit)
    if (res.status === 401 || res.status === 403) {
      throw new WebdavError('认证失败，请检查 WebDAV 用户名/密码（应用专用密码）', res.status, 'auth')
    }
    if (!res.ok) {
      throw new WebdavError(httpStatusText(res.status), res.status)
    }
    return { bytesSent: s.size }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new WebdavError(`上传超时（>${opts?.timeoutMin ?? 30} 分钟）`, undefined, 'connect')
    }
    if (err instanceof WebdavError) throw err
    throw new WebdavError(explainFetchError(err), undefined, 'connect')
  } finally {
    clearTimeout(timer)
    body.destroy()
  }
}

/** PROPFIND Depth 1 列目录（保留策略用） */
export interface RemoteFile {
  name: string
  size: number
  modifiedAt: string
}

export async function listFiles(c: WebdavCreds, timeoutMs = 30000): Promise<RemoteFile[]> {
  let res: Response
  try {
    res = await fetch(joinUrl(c.url), {
      method: 'PROPFIND',
      headers: {
        Authorization: authHeader(c),
        Depth: '1',
        'Content-Type': 'application/xml',
      },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new WebdavError(explainFetchError(err), undefined, 'connect')
  }
  if (!res.ok && res.status !== 207) {
    if (res.status === 401 || res.status === 403) {
      throw new WebdavError('认证失败，请检查 WebDAV 用户名/密码（应用专用密码）', res.status, 'auth')
    }
    throw new WebdavError(httpStatusText(res.status), res.status)
  }
  const xml = await res.text()
  return parsePropfind(xml, c.url)
}

/** 轻量 XML 解析（避免引依赖；处理 <d:response> 块） */
function parsePropfind(xml: string, baseUrl: string): RemoteFile[] {
  const out: RemoteFile[] = []
  const responses = xml.split(/<\/?[a-zA-Z0-9]*:?response>/).filter((s) => s.includes('href'))
  const selfPath = new URL(baseUrl).pathname
  for (const chunk of responses) {
    if (/<[a-zA-Z0-9]*:?collection\s*\/?>/.test(chunk)) continue // 目录跳过
    const hrefMatch = chunk.match(/<[a-zA-Z0-9]*:?href>\s*([^<]+?)\s*<\/[a-zA-Z0-9]*:?href>/)
    if (!hrefMatch) continue
    const href = decodeURIComponent(hrefMatch[1] ?? '')
    const name = href.split('/').filter(Boolean).pop() ?? ''
    if (!name || href.replace(/\/$/, '') === selfPath.replace(/\/$/, '')) continue
    const sizeMatch = chunk.match(/<[a-zA-Z0-9]*:?getcontentlength>\s*(\d+)\s*<\/[a-zA-Z0-9]*:?getcontentlength>/)
    const modMatch = chunk.match(/<[a-zA-Z0-9]*:?getlastmodified>\s*([^<]+?)\s*<\/[a-zA-Z0-9]*:?getlastmodified>/)
    let modifiedAt = ''
    if (modMatch) {
      const d = new Date(modMatch[1] ?? '')
      modifiedAt = isNaN(d.getTime()) ? (modMatch[1] ?? '') : d.toISOString()
    }
    out.push({ name, size: sizeMatch ? Number(sizeMatch[1]) : 0, modifiedAt })
  }
  return out
}

/** DELETE（尽力而为：失败不抛，保留策略侧记录） */
export async function deleteFile(c: WebdavCreds, fileName: string): Promise<boolean> {
  try {
    const res = await fetch(joinUrl(c.url, fileName), {
      method: 'DELETE',
      headers: { Authorization: authHeader(c) },
      signal: AbortSignal.timeout(30000),
    })
    return res.ok || res.status === 404
  } catch {
    return false
  }
}

/** 远端目录占用统计（容量水位用）：listFiles 求和 */
export async function usedBytes(c: WebdavCreds): Promise<number> {
  const files = await listFiles(c)
  return files.reduce((sum, f) => sum + f.size, 0)
}
