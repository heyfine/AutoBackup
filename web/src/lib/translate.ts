/**
 * 运行错误展示中文化（兜底层）。
 * 新版后端错误已在 webdav.ts 中文化；这里负责翻译历史库中的旧英文错误
 * 与任何漏网英文，保证仪表盘展示始终可读。
 */

const RULES: [RegExp, string][] = [
  [/MKCOL connect failed: fetch failed/i, '无法连接目标 WebDAV 服务器（网络不可达），请检查地址与网络'],
  [/getaddrinfo ENOTFOUND|ENOTFOUND/i, '域名解析失败：WebDAV 地址的域名无法解析，请检查地址是否正确'],
  [/connect ECONNREFUSED|ECONNREFUSED/i, '连接被拒绝：目标服务器地址/端口错误，或服务未启动'],
  [/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timed out/i, '连接超时：目标服务器无响应（网络不稳定或被防火墙拦截）'],
  [/socket hang up|ECONNRESET|EPIPE/i, '连接被中断：网络不稳定或目标服务器断开连接'],
  [/self signed|certificate|CERT_/i, 'SSL 证书校验失败：目标服务器使用无效或过期证书，连接被拒绝'],
  [/HTTP 401|HTTP 403/i, '认证失败：请检查 WebDAV 用户名/密码（应用专用密码）'],
  [/HTTP 404/i, '路径不存在：请检查 WebDAV 地址是否包含正确的子目录'],
  [/HTTP 429/i, '请求过于频繁：被目标服务器限速，请稍后重试'],
  [/HTTP 507/i, '存储空间不足：目标配额已满，请清理旧备份或扩容'],
  [/HTTP 5\d\d/i, '目标服务器异常或维护中，请稍后重试'],
  [/ENOSPC/i, '本地磁盘空间不足，无法写入备份文件'],
  [/fetch failed/i, '网络请求失败：无法连接目标服务器，请检查网络与地址'],
]

/** 翻译单段错误文本；命中规则返回中文，未命中原样返回 */
function translateInner(text: string): string {
  const t = text.trim()
  for (const [re, zh] of RULES) {
    if (re.test(t)) return zh
  }
  return text
}

/**
 * 翻译运行错误。保留形如 `koofr-main: ...` 的英文目标前缀，
 * 让用户知道是哪个目标出问题；纯中文或未知错误原样返回。
 */
export function translateRunError(text: string): string {
  const t = text.trim()
  if (!t) return text
  const inner = translateInner(t)
  if (inner === text) return text
  const m = t.match(/^([^:：]+):\s+.+$/)
  const prefix = m && !/[\u4e00-\u9fff]/.test(m[1] ?? '') ? `${m[1]}：` : ''
  return `${prefix}${inner}`
}