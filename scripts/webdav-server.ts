/**
 * 最小 WebDAV 模拟服务器（本地端到端测试用）：
 * 支持 MKCOL / PUT / PROPFIND(Depth 0/1) / DELETE，文件落本地目录。
 * 用法：node dist/scripts/webdav-server.js [port] [rootDir]
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const port = Number(process.argv[2] ?? 9800)
const root = process.argv[3] ?? join(process.cwd(), '.webdav-test')
mkdirSync(root, { recursive: true })

function safePath(urlPath: string): string {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '')
  const p = join(root, rel)
  if (!p.startsWith(root)) throw new Error('path traversal')
  return p
}

const server = createServer((req, res) => {
  const urlPath = new URL(req.url ?? '/', 'http://x').pathname
  let filePath: string
  try {
    filePath = safePath(urlPath)
  } catch {
    res.writeHead(403).end()
    return
  }

  if (req.method === 'MKCOL') {
    mkdirSync(filePath, { recursive: true })
    res.writeHead(201).end()
    return
  }

  if (req.method === 'PUT') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      mkdirSync(dirname(filePath), { recursive: true })
      writeFileSync(filePath, Buffer.concat(chunks))
      res.writeHead(201).end()
    })
    return
  }

  if (req.method === 'DELETE') {
    if (!existsSync(filePath)) {
      res.writeHead(404).end()
      return
    }
    rmSync(filePath, { recursive: true })
    res.writeHead(204).end()
    return
  }

  if (req.method === 'PROPFIND') {
    const depth = Number(req.headers['depth'] ?? '0')
    if (!existsSync(filePath)) {
      res.writeHead(404).end()
      return
    }
    const st = statSync(filePath)
    if (!st.isDirectory()) {
      res.writeHead(405).end()
      return
    }
    const items: string[] = []
    const selfHref = urlPath.endsWith('/') ? urlPath : `${urlPath}/`
    if (depth >= 0) {
      items.push(
        `<d:response><d:href>${selfHref}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`,
      )
    }
    if (depth >= 1) {
      for (const name of readdirSync(filePath)) {
        const full = join(filePath, name)
        const s = statSync(full)
        if (s.isDirectory()) {
          items.push(
            `<d:response><d:href>${selfHref}${name}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`,
          )
        } else {
          items.push(
            `<d:response><d:href>${selfHref}${encodeURIComponent(name)}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${s.size}</d:getcontentlength><d:getlastmodified>${s.mtime.toUTCString()}</d:getlastmodified></d:prop></d:propstat></d:response>`,
          )
        }
      }
    }
    const body = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${items.join('')}</d:multistatus>`
    res.writeHead(207, { 'Content-Type': 'application/xml' }).end(body)
    return
  }

  if (req.method === 'GET') {
    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200).end(readFileSync(filePath))
    return
  }

  res.writeHead(405).end(`method ${req.method} not supported`)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock webdav on http://127.0.0.1:${port} root=${root}`)
})
