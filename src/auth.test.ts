import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdminAuth } from './server.js'

/**
 * 管理员认证回归（2026-09-12 首启自建改造）。
 * 守护：①setup 一次性窗口（建成即关）②未配置时 verify 拒绝而不抛 500
 * ③密码文件原子落盘 0600 语义 ④登录限频 ⑤改密全端登出。
 */

let home = ''
let auth: AdminAuth

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ab-auth-'))
  auth = new AdminAuth(home)
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('AdminAuth 首启自建', () => {
  it('未初始化：isConfigured false，verify 拒绝一切且不抛（旧版 readFileSync 500 回归）', () => {
    expect(auth.isConfigured()).toBe(false)
    expect(() => auth.verify('anything')).not.toThrow()
    expect(auth.verify('anything')).toBe(false)
  })

  it('setupPassword：短密码拒 / 合法成功 / 二次调用拒绝（一次性窗口）', () => {
    expect(auth.setupPassword('1234567')).toBe(false)
    expect(auth.isConfigured()).toBe(false)
    expect(auth.setupPassword('my-own-pwd-8')).toBe(true)
    expect(auth.isConfigured()).toBe(true)
    // 窗口永久关闭：再次 setup 任何密码都无效，原密码不变
    expect(auth.setupPassword('hijacker-pwd-99')).toBe(false)
    expect(auth.verify('my-own-pwd-8')).toBe(true)
    expect(auth.verify('hijacker-pwd-99')).toBe(false)
  })

  it('密码明文只落 admin-password.txt 单文件', () => {
    auth.setupPassword('stored-pwd-123')
    const raw = readFileSync(join(home, 'admin-password.txt'), 'utf8').trim()
    expect(raw).toBe('stored-pwd-123')
  })

  it('setup 后直接发 session 可用（创建即登录链路）', () => {
    auth.setupPassword('pwd-after-setup')
    const token = auth.createSession()
    expect(auth.isValid(token)).toBe(true)
  })

  it('登录限频：错 5 次后第 6 次即使正确也拒绝', () => {
    auth.setupPassword('limit-pwd-123')
    for (let i = 0; i < 5; i++) expect(auth.verify('wrong')).toBe(false)
    expect(auth.verify('limit-pwd-123')).toBe(false)
  })

  it('changePassword：错旧密码/短新密码均拒；成功则新密码生效且全端登出', () => {
    auth.setupPassword('old-pwd-1234')
    expect(auth.changePassword('bad', 'new-pwd-1234')).toBe(false)
    expect(auth.changePassword('old-pwd-1234', 'short')).toBe(false)
    const token = auth.createSession()
    expect(auth.changePassword('old-pwd-1234', 'new-pwd-1234')).toBe(true)
    expect(auth.isValid(token)).toBe(false) // 旧 session 全部失效
    expect(auth.verify('new-pwd-1234')).toBe(true)
  })
})
