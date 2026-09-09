// M1 端到端验证：从模拟 WebDAV 下载 artifact → 解包 → 比对内容
import { extract } from 'tar-stream'
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { writeFileSync } from 'node:fs'

const res = await fetch('http://127.0.0.1:9800/backup/test-dir/test-dir_2026-09-09_11-44-52-824.tar.gz')
if (!res.ok) {
  console.error('download failed:', res.status)
  process.exit(1)
}
const buf = Buffer.from(await res.arrayBuffer())
writeFileSync('.webdav-test/downloaded.tar.gz', buf)

const files = new Map()
const ex = extract()
ex.on('entry', (header, stream, next) => {
  const chunks = []
  stream.on('data', (c) => chunks.push(c))
  stream.on('end', () => {
    files.set(header.name, Buffer.concat(chunks).toString('utf8'))
    next()
  })
})
await pipeline(
  (async function* () {
    yield buf
  })(),
  createGunzip(),
  ex,
)
console.log('entries:', [...files.keys()])
const important = [...files.entries()].find(([k]) => k.endsWith('important.txt'))
const config = [...files.entries()].find(([k]) => k.endsWith('config.json'))
console.log('important.txt content:', important?.[1])
console.log('config.json content:', config?.[1])
console.log('ROUNDTRIP_OK:', (important?.[1] ?? '').includes('关键数据') && (config?.[1] ?? '').includes('keys-are-here'))
