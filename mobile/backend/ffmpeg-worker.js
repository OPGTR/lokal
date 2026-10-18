'use strict'
// Runs ffmpeg (WebAssembly build) for tools.js, off the server's thread.
// Input files are copied into ffmpeg's in-memory file system and the output
// copied back to where it was asked for.
const { parentPort } = require('worker_threads')
const fs = require('fs')
const path = require('path')

// The core is built for a web worker: give it what it looks for.
globalThis.self = globalThis
globalThis.location = { href: 'file:///lokal-ffmpeg/' }

let core = null
let currentId = 0

async function load() {
  const factory = require('@ffmpeg/core')
  const create = typeof factory === 'function' ? factory : factory.default
  const wasmFile = path.join(path.dirname(require.resolve('@ffmpeg/core')), 'ffmpeg-core.wasm')
  core = await create({
    wasmBinary: fs.readFileSync(wasmFile),
    locateFile: (p) => p,
    print: (line) => parentPort.postMessage({ type: 'log', id: currentId, line }),
    printErr: (line) => parentPort.postMessage({ type: 'log', id: currentId, line }),
  })
  for (const dir of ['/in', '/out']) { try { core.FS.mkdir(dir) } catch {} }
}

function clean(dir) {
  try { for (const name of core.FS.readdir(dir)) if (name !== '.' && name !== '..') core.FS.unlink(`${dir}/${name}`) } catch {}
}

function run({ id, args, cwd }) {
  currentId = id
  const list = [...args]
  const copies = []
  let n = 0
  // Inputs: whatever follows -i.
  for (let i = 1; i < list.length; i++) {
    if (list[i - 1] !== '-i') continue
    const real = path.resolve(cwd || '/', list[i])
    if (!fs.existsSync(real)) continue
    const virtual = `/in/${n++}${path.extname(real).replace(/[^.\w]/g, '')}`
    core.FS.writeFile(virtual, fs.readFileSync(real))
    list[i] = virtual
  }
  // Output: the last argument (or stdout).
  let output = null
  let toStdout = false
  const last = list.length - 1
  if (last >= 0 && list[last - 1] !== '-i') {
    const arg = list[last]
    if (arg === '-' || arg === 'pipe:' || arg === 'pipe:1') {
      toStdout = true
      list[last] = '/out/stdout.bin'
    } else if (!arg.startsWith('-')) {
      output = path.resolve(cwd || '/', arg)
      list[last] = `/out/result${path.extname(output).replace(/[^.\w]/g, '')}`
      copies.push([list[last], output])
    }
  }
  if (!list.includes('-y') && !list.includes('-n')) list.unshift('-y')
  let code
  try {
    code = core.exec(...list)
  } catch (e) {
    parentPort.postMessage({ type: 'log', id, line: `ffmpeg: ${e && e.message || e}` })
    code = 1
  }
  try {
    if (code === 0) {
      for (const [virtual, real] of copies) {
        fs.mkdirSync(path.dirname(real), { recursive: true })
        fs.writeFileSync(real, core.FS.readFile(virtual))
      }
      if (toStdout) {
        let data = null
        try { data = core.FS.readFile('/out/stdout.bin') } catch {}
        if (data && data.length) parentPort.postMessage({ type: 'stdout', id, data }, [data.buffer])
      }
    }
  } catch (e) {
    parentPort.postMessage({ type: 'log', id, line: `ffmpeg: could not write the output: ${e.message}` })
    code = 1
  } finally {
    clean('/in'); clean('/out')
    try { core.reset() } catch {}
  }
  parentPort.postMessage({ type: 'done', id, code })
}

load().then(() => {
  parentPort.postMessage({ type: 'ready' })
  parentPort.on('message', (m) => { if (m && m.type === 'run') run(m) })
}, (e) => parentPort.postMessage({ type: 'fatal', error: e && e.message || String(e) }))
