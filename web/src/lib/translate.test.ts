import { describe, expect, it } from 'vitest'
import { translateRunError } from './translate.js'

describe('translateRunError（仪表盘历史英文错误中文化）', () => {
  it('历史 MKCOL fetch failed 带目标前缀 → 中文说明并保留目标', () => {
    expect(translateRunError('koofr-main: MKCOL connect failed: fetch failed')).toBe(
      'koofr-main：无法连接目标 WebDAV 服务器（网络不可达），请检查地址与网络',
    )
  })

  it('DNS 解析失败', () => {
    expect(translateRunError('fetch failed: getaddrinfo ENOTFOUND app.koofr.net')).toContain('域名解析失败')
  })

  it('连接被拒绝 / 超时 / 断连', () => {
    expect(translateRunError('connect ECONNREFUSED 1.2.3.4:443')).toContain('连接被拒绝')
    expect(translateRunError('connect ETIMEDOUT 1.2.3.4:443')).toContain('连接超时')
    expect(translateRunError('socket hang up')).toContain('连接被中断')
  })

  it('证书与常见 HTTP 状态', () => {
    expect(translateRunError('self signed certificate in chain')).toContain('SSL')
    expect(translateRunError('上传失败：HTTP 507')).toContain('配额已满')
    expect(translateRunError('MKCOL 失败：HTTP 429')).toContain('限速')
  })

  it('已中文/未知错误原样返回', () => {
    expect(translateRunError('认证失败，请检查用户名/密码')).toBe('认证失败，请检查用户名/密码')
    expect(translateRunError('custom weird error')).toBe('custom weird error')
  })
})