// 调试：复现 tar 打包 → 解包，检查条目名分隔符
import { extract } from 'tar-stream'
import { createReadStream, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const srcDir = mkdtempSync(join(tmpdir(), 'tar-src-'))
mkdirSync(join(srcDir, 'sub'), { recursive: true })
writeFileSync(join(srcDir, 'a.txt'), 'hello A')
writeFileSync(join(srcDir, 'sub', 'b.txt'), 'hello B')

const { pack } = await import('../dist/core/packer.js')
const homeDir = mkdtempSync(join(tmpdir(), 'tar-home-'))
const profile = {
  id: 'dbg',
  name: 'dbg',
  kind: 'directory',
  paths: [srcDir],
  containers: [],
  encrypt: false,
  consistency: 'best_effort',
  enabled: true,
  isDraft: false,
}
const packed = await pack(profile, srcDir, { homeDir, snapshotAt: new Date().toISOString() })
console.log('packed:', packed.artifactPath)

const names = []
const ex = extract()
ex.on('entry', (header, stream, next) => {
  names.push(header.name)
  stream.resume()
  next()
})
ex.on('finish', () => console.log('entries:', JSON.stringify(names)))
await pipeline(createReadStream(packed.artifactPath), createGunzip(), ex)
