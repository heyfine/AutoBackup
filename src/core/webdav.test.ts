import { describe, expect, it } from 'vitest'
import { explainFetchError, httpStatusText } from './webdav.js'

function netErr(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('explainFetchError（网络错误中文化）', () => {
  it('undici 多层 cause 解包：DNS 解析失败', () => {
    const err = new TypeError('fetch failed', {
      cause: new TypeError('fetch failed', { cause: netErr('ENOTFOUND', 'getaddrinfo ENOTFOUND app.koofr.net') }),
    })
    expect(explainFetchError(err)).toContain('域名解析失败')
  })

  it('连接被拒绝 → 地址/端口提示', () => {
    const err = new TypeError('fetch failed', { cause: netErr('ECONNREFUSED', 'connect ECONNREFUSED') })
    expect(explainFetchError(err)).toContain('服务器拒绝连接')
  })

  it('超时 → 网络/防火墙提示', () => {
    const err = new TypeError('fetch failed', { cause: netErr('ETIMEDOUT', 'connect ETIMEDOUT') })
    expect(explainFetchError(err)).toContain('连接超时')
  })

  it('证书错误 → SSL 提示', () => {
    const err = new TypeError('fetch failed', {
      cause: netErr('DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate'),
    })
    expect(explainFetchError(err)).toContain('SSL')
  })

  it('普通错误兜底 → 网络不可达', () => {
    expect(explainFetchError(new Error('boom'))).toContain('网络不可达')
  })
})

describe('httpStatusText（HTTP 状态中文化）', () => {
  it('常见状态有明确中文说明', () => {
    expect(httpStatusText(404)).toContain('路径不存在')
    expect(httpStatusText(423)).toContain('锁定')
    expect(httpStatusText(429)).toContain('限速')
    expect(httpStatusText(507)).toContain('配额已满')
    expect(httpStatusText(503)).toContain('维护')
  })

  it('未知状态回退到 HTTP 数字', () => {
    expect(httpStatusText(418)).toContain('418')
  })
})