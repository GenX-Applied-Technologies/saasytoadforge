import { build } from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(`${root}/dist`, { recursive: true })
await build({ entryPoints: [`${root}/src/main.js`], bundle: true, outfile: `${root}/dist/game.js`,
  platform: 'browser', format: 'iife', minify: true, legalComments: 'linked' })
await copyFile(`${root}/index.html`, `${root}/dist/index.html`)
await copyFile(`${root}/LICENSES.md`, `${root}/dist/LICENSES.md`)
await copyFile(`${root}/node_modules/phaser/LICENSE.md`, `${root}/dist/PHASER-LICENSE.txt`)
console.log('Built trusted Phaser template (real local esbuild; not sandbox execution)')
