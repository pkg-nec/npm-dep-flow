import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

// A deterministic POSIX ustar archive: no platform tar executable or npm pack scripts.
export function tarball(manifest, files = {}) {
  const chunks = []
  for (const [name, body] of [['package/package.json', JSON.stringify(manifest)], ['package/index.js', `module.exports = ${JSON.stringify({ name: manifest.name, version: manifest.version })}\n`], ...Object.entries(files).map(([name, body]) => ['package/' + name, body])]) {
    const data = Buffer.from(body), header = Buffer.alloc(512)
    const put = (s, start, size) => header.write(s, start, size, 'ascii')
    const oct = (n, start, size) => put(n.toString(8).padStart(size - 1, '0') + '\0', start, size)
    put(name, 0, 100)
    oct(0o644, 100, 8)
    oct(0, 108, 8)
    oct(0, 116, 8)
    oct(data.length, 124, 12)
    oct(0, 136, 12)
    put('        ', 148, 8)
    put('0', 156, 1)
    put('ustar\0', 257, 6)
    put('00', 263, 2)
    const sum = header.reduce((a, b) => a + b, 0)
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  const bytes = gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), { mtime: 0 })
  return { bytes, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'), shasum: createHash('sha1').update(bytes).digest('hex') }
}
