import { createReadStream, type ReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { ReadableStream as NodeWebReadable } from 'node:stream/web'

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
      throw new WebdavError(`MKCOL connect failed: ${err instanceof Error ? err.message : String(err)}`, undefined, 'connect')
    })
    if (res.status === 401 || res.status === 403) {
      throw new WebdavError('认证失败，请检查 WebDAV 用户名/密码', res.status, 'auth')
    }
    if (res.status !== 201 && res.status !== 405 && res.status !== 409) {
      throw new WebdavError(`MKCOL 失败：HTTP ${res.status}`, res.status)
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
    return { ok: false, message: `WebDAV 服务器返回 ${res.status}` }
  } catch (err) {
    if (err instanceof WebdavError) return { ok: false, message: err.message }
    return { ok: false, message: `无法连接：${err instanceof Error ? err.message : String(err)}` }
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
      throw new WebdavError('认证失败', res.status, 'auth')
    }
    if (!res.ok) {
      throw new WebdavError(`上传失败：HTTP ${res.status}`, res.status)
    }
    return { bytesSent: s.size }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new WebdavError(`上传超时（>${opts?.timeoutMin ?? 30} 分钟）`, undefined, 'connect')
    }
    throw err
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
  const res = await fetch(joinUrl(c.url), {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(c),
      Depth: '1',
      'Content-Type': 'application/xml',
    },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok && res.status !== 207) {
    throw new WebdavError(`列目录失败：HTTP ${res.status}`, res.status)
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
