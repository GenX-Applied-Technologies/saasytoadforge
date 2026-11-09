// Local trusted-artifact preview only. Not an untrusted-code executor.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
const root = new URL('../dist/', import.meta.url)
const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'],
  '/game.js': ['game.js', 'text/javascript'], '/game.js.LEGAL.txt': ['game.js.LEGAL.txt', 'text/plain'],
  '/LICENSES.md': ['LICENSES.md', 'text/plain'], '/PHASER-LICENSE.txt': ['PHASER-LICENSE.txt', 'text/plain'] }
createServer(async (req, res) => {
  const file = files[new URL(req.url, 'http://localhost').pathname]
  if (!file) { res.writeHead(404); res.end('Not found'); return }
  try {
    const bytes = await readFile(new URL(file[0], root))
    res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'" })
    res.end(bytes)
  } catch { res.writeHead(404); res.end('Build the game first') }
}).listen(4317, '127.0.0.1', () => console.log('Game preview: http://127.0.0.1:4317'))
