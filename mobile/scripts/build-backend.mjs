// Bundles Lokal's server (server/ + electron/ backend code) into one CommonJS
// file the phone's Node.js 18 (nodejs-mobile, no ICU) can run:
//   - ESM-only dependencies become CommonJS (Node 18 can't require() ESM),
//   - better-sqlite3 -> WebAssembly SQLite adapter, electron/sharp -> stubs,
//   - Unicode property regexes (\p{L}...) are expanded to plain ranges,
//     because V8 without ICU can't even parse them,
//   - packages that load .wasm files next to themselves are shipped as-is.
// Output: mobile/build/www/nodejs/ (the Capacitor webDir's Node.js project).
import { build } from 'esbuild'
import { transformAsync } from '@babel/core'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const mobile = path.resolve(here, '..')
const root = path.resolve(mobile, '..')
const out = path.join(mobile, 'build', 'www', 'nodejs')
const requireMobile = createRequire(path.join(mobile, 'package.json'))
const requireRoot = createRequire(path.join(root, 'package.json'))

// Shipped unbundled in nodejs/node_modules (they read files beside themselves).
const SHIPPED = {
  'node-sqlite3-wasm': requireMobile,
  'quickjs-emscripten': requireRoot,
  'quickjs-emscripten-core': requireRoot,
  '@jitl/quickjs-ffi-types': requireRoot,
  '@jitl/quickjs-wasmfile-release-sync': requireRoot,
  '@jitl/quickjs-wasmfile-release-asyncify': requireRoot,
  // ffmpeg as WebAssembly (backend/tools.js): only its CommonJS build.
  '@ffmpeg/core': requireMobile,
}

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

const alias = {
  'better-sqlite3': path.join(mobile, 'backend', 'sqlite-adapter.js'),
  electron: path.join(mobile, 'backend', 'electron-stub.js'),
  sharp: path.join(mobile, 'backend', 'sharp-stub.js'),
}

// Two workers are both called "worker.js" next to their module; in one
// bundle folder they need distinct names.
const WORKERS = {
  [path.join(root, 'electron', 'automix', 'index.js')]: 'automix-worker.js',
  [path.join(root, 'electron', 'spotiflac', 'runtime.js')]: 'spotiflac-worker.js',
}

const lokalPlugin = {
  name: 'lokal-android',
  setup(b) {
    b.onResolve({ filter: /^(better-sqlite3|electron|sharp)$/ }, (args) => ({ path: alias[args.path] }))
    b.onResolve({ filter: /^bridge$/ }, () => ({ path: 'bridge', external: true }))
    // Native-only pieces of the desktop app: never loaded on Android.
    b.onResolve({ filter: /^(discord-rpc|electron-updater|electron-log|electron-store|@puppeteer\/browsers)$/ }, (args) => ({ path: args.path, namespace: 'lokal-absent' }))
    b.onLoad({ filter: /.*/, namespace: 'lokal-absent' }, (args) => ({
      contents: `throw Object.assign(new Error(${JSON.stringify(args.path + ' is not available on Android')}), { code: 'MODULE_NOT_FOUND' })`,
      loader: 'js',
    }))
    for (const name of Object.keys(SHIPPED)) {
      const re = new RegExp(`^${name.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}(/.*)?$`)
      b.onResolve({ filter: re }, (args) => ({ path: args.path, external: true }))
    }
    b.onLoad({ filter: /electron[\\/](automix[\\/]index|spotiflac[\\/]runtime)\.js$/ }, async (args) => {
      const target = WORKERS[path.normalize(args.path)]
      let contents = await fs.promises.readFile(args.path, 'utf8')
      if (target) contents = contents.replace(/path\.join\(__dirname,\s*'worker\.js'\)/, `path.join(__dirname, ${JSON.stringify(target)})`)
      return { contents, loader: 'js' }
    })
  },
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  plugins: [lokalPlugin],
  logLevel: 'warning',
  legalComments: 'none',
  minifySyntax: true,
  keepNames: true,
  // Some ESM dependencies read import.meta.url: give them the bundle's URL.
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
  loader: { '.node': 'empty' },
  // ESM-only packages (music-metadata...) export under these conditions only.
  conditions: ['module-sync', 'node'],
  nodePaths: [path.join(root, 'node_modules'), path.join(mobile, 'node_modules')],
}

const entries = [
  { in: path.join(mobile, 'backend', 'entry.js'), out: 'index.js' },
  { in: path.join(root, 'electron', 'automix', 'worker.js'), out: 'automix-worker.js' },
  { in: path.join(root, 'electron', 'spotiflac', 'worker.js'), out: 'spotiflac-worker.js' },
  { in: path.join(mobile, 'backend', 'ffmpeg-worker.js'), out: 'ffmpeg-worker.js' },
]

for (const entry of entries) {
  const result = await build({ ...common, entryPoints: [entry.in], outfile: path.join(out, entry.out), metafile: true })
  const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
  console.log(`bundled ${entry.out} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
}

// new RegExp('\\p{M}', 'gu') with literal arguments -> /\p{M}/gu, so the
// regex plugins below can expand it too.
function regexConstructorToLiteral({ types: t }) {
  return {
    visitor: {
      'NewExpression|CallExpression'(p) {
        const { callee, arguments: args } = p.node
        if (!t.isIdentifier(callee, { name: 'RegExp' }) || !args.length || args.length > 2) return
        if (!args.every(a => t.isStringLiteral(a))) return
        const pattern = args[0].value, flags = args[1]?.value || ''
        if (!/\\[pP]\{/.test(pattern) && !flags.includes('v')) return
        try { new RegExp(pattern, flags) } catch { return }
        p.replaceWith(t.regExpLiteral(pattern.replace(/(\\.)|\//g, (m, escaped) => escaped || '\\/'), flags))
      },
    },
  }
}

// Expand \p{...} / the v flag into plain ranges (V8 without ICU can't parse them).
for (const file of entries.map(e => path.join(out, e.out))) {
  const code = await fs.promises.readFile(file, 'utf8')
  if (!/\\[pP]\{|\/[a-z]*v[a-z]*[,;)\s.]/.test(code)) continue
  const result = await transformAsync(code, {
    babelrc: false,
    configFile: false,
    compact: false,
    sourceType: 'script',
    plugins: [
      regexConstructorToLiteral,
      requireMobile.resolve('@babel/plugin-transform-unicode-sets-regex'),
      requireMobile.resolve('@babel/plugin-transform-unicode-property-regex'),
    ],
  })
  await fs.promises.writeFile(file, result.code)
  console.log(`expanded Unicode regexes in ${path.basename(file)}`)
}

// Copy the packages shipped as files (and their own dependencies).
function copyPackage(name, req) {
  // Not via require.resolve: packages with an "exports" map may hide package.json.
  const pkgJson = (req.resolve.paths(name) || []).map(dir => path.join(dir, name, 'package.json')).find(f => fs.existsSync(f))
  if (!pkgJson) throw new Error(`${name} is not installed`)
  const src = path.dirname(pkgJson)
  const dest = path.join(out, 'node_modules', name)
  if (fs.existsSync(dest)) return
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p)
      if (/(^|[\\/])(test|tests|docs|example|examples|\.github)([\\/]|$)/.test(rel)) return false
      if (name === '@ffmpeg/core' && /^dist[\\/]esm/.test(rel)) return false
      return !/\.(map|md)$/.test(p)
    },
  })
  const meta = JSON.parse(fs.readFileSync(pkgJson, 'utf8'))
  const depReq = createRequire(pkgJson)
  for (const dep of Object.keys(meta.dependencies || {})) {
    try { copyPackage(dep, depReq) } catch {}
  }
}
for (const [name, req] of Object.entries(SHIPPED)) {
  try { copyPackage(name, req) } catch (e) { console.warn(`could not ship ${name}: ${e.message}`) }
}

// Things the server reads at runtime from beside itself.
const publicSrc = path.join(root, 'public')
fs.mkdirSync(path.join(out, 'public'), { recursive: true })
for (const f of ['lokal-icon.png']) {
  if (fs.existsSync(path.join(publicSrc, f))) fs.copyFileSync(path.join(publicSrc, f), path.join(out, 'public', f))
}
const ui = path.join(mobile, 'build', 'ui')
if (fs.existsSync(ui)) fs.cpSync(ui, path.join(out, 'ui'), { recursive: true })
else console.warn('mobile/build/ui is missing: run "npm run build:ui" first (the interface is served by the Node.js server)')

fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: 'lokal-android-server', version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, main: 'index.js', private: true }, null, 2))
console.log(`backend ready in ${path.relative(root, out)}`)
