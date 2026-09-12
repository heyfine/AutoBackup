import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdminAuth } from './server.js'

/**
 * 管理员认证回归（2026-09-12 用户名+密码自建改造）。
 * 守护：①setup 一次性窗口 ②用户名合法性规则 ③存量「纯密码」部署兼容（默认 admin）
 * ④自定义用户名后 admin 失效 ⑤改用户名即时生效 ⑥登录限频 ⑦改密全端登出。
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

describe('AdminAuth 用户名+密码', () => {
  it('未初始化：login 拒绝一切且不抛', () => {
    expect(auth.isConfigured()).toBe(false)
    expect(auth.login('admin', 'anything')).toBe(false)
  })

  it('setupAccount：非法用户名/短密码拒 → 合法成功写双文件 → 窗口永久关闭', () => {
    expect(auth.setupAccount('a', 'password-123')).toBe(false) // 用户名 <2
    expect(auth.setupAccount('my user', 'password-123')).toBe(false) // 含空格
    expect(auth.setupAccount('ad/min', 'password-123')).toBe(false) // 含路径字符
    expect(auth.setupAccount('myuser', 'short1234')).toBe(true)
    expect(auth.isConfigured()).toBe(true)
    expect(auth.getUsername()).toBe('myuser')
    expect(readFileSync(join(home, 'admin-username.txt'), 'utf8')).toBe('myuser')
    // 一次性窗口：再次 setup 拒绝且原凭据不变
    expect(auth.setupAccount('hijacker', 'hijack-pass-99')).toBe(false)
    expect(auth.login('hijacker', 'hijack-pass-99')).toBe(false)
    expect(auth.login('myuser', 'short1234')).toBe(true)
  })

  it('中文用户名支持', () => {
    expect(auth.setupAccount('备份管理员', 'password-123')).toBe(true)
    expect(auth.login('备份管理员', 'password-123')).toBe(true)
  })

  it('存量兼容：只有密码文件（无用户名文件）时默认用户名为 admin', () => {
    writeFileSync(join(home, 'admin-password.txt'), 'legacy-pwd-123', { mode: 0o600 })
    expect(auth.hasCustomUsername()).toBe(false)
    expect(auth.getUsername()).toBe('admin')
    expect(auth.login('admin', 'legacy-pwd-123')).toBe(true)
    expect(auth.login('someone', 'legacy-pwd-123')).toBe(false)
  })

  it('自定义用户名后默认 admin 失效；改用户名即时生效', () => {
    auth.setupAccount('first-name', 'password-123')
    expect(auth.login('admin', 'password-123')).toBe(false)
    expect(auth.changeUsername('我的名字')).toBe('我的名字')
    expect(auth.login('我的名字', 'password-123')).toBe(true)
    expect(auth.login('first-name', 'password-123')).toBe(false) // 旧名失效
    expect(auth.changeUsername('x')).toBeNull() // 非法长度不改
    expect(auth.getUsername()).toBe('我的名字') // 非法调用不留坏数据
  })

  it('登录限频：错 5 次（含错用户名）后第 6 次即使正确也拒绝', () => {
    auth.setupAccount('ratelimit-user', 'password-123')
    for (let i = 0; i < 5; i++) expect(auth.login('wrong-name', 'password-123')).toBe(false)
    expect(auth.login('ratelimit-user', 'password-123')).toBe(false)
  })

  it('changePassword：错旧密码/短新密码拒；成功则新密码生效且全端登出', () => {
    auth.setupAccount('pwdowner', 'old-password-1')
    expect(auth.changePassword('bad', 'new-password-1')).toBe(false)
    expect(auth.changePassword('old-password-1', 'short')).toBe(false)
    const token = auth.createSession()
    expect(auth.changePassword('old-password-1', 'new-password-1')).toBe(true)
    expect(auth.isValid(token)).toBe(false)
    expect(auth.login('pwdowner', 'new-password-1')).toBe(true)
  })
})
