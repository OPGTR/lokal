// Builds the app's shell page (mobile/shell) into the Capacitor webDir.
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mobile = path.resolve(here, '..')
const root = path.resolve(mobile, '..')
const src = path.join(mobile, 'shell')
const out = path.join(mobile, 'build', 'www')

fs.mkdirSync(out, { recursive: true })
await build({
  entryPoints: [path.join(src, 'shell.js')],
  outfile: path.join(out, 'shell.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100'],
  minify: true,
  legalComments: 'none',
  logLevel: 'warning',
})
for (const f of ['index.html', 'shell.css']) fs.copyFileSync(path.join(src, f), path.join(out, f))
fs.copyFileSync(path.join(root, 'public', 'lokal-icon.png'), path.join(out, 'icon.png'))
console.log('shell ready in mobile/build/www')
