'use strict'
// ffmpeg and ffprobe on Android.
//
// Android won't let an app start programs, and Lokal's backend calls ffmpeg /
// ffprobe as programs: SpotiFLAC addons (probe every download, decrypt some
// sources, change containers), playable copies of ALAC, quality checks.
// This module stands in for those two programs, so the backend code stays
// as it is:
//   - spawn('ffmpeg', args) runs ffmpeg compiled to WebAssembly, in a worker
//     thread (the server keeps answering meanwhile), one job at a time;
//   - spawn('ffprobe', [... -of json, file]) answers from the file's tags
//     (music-metadata, which Lokal already uses for scanning).
// Everything else that tries to start a program gets the usual "can't
// start it" error, exactly as on a phone.

const childProcess = require('child_process')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const path = require('path')
const fs = require('fs')

const TOOL_RE = /(^|[\\/])(ffmpeg|ffprobe)(\.exe)?$/i
const VERSION_TEXT = 'ffmpeg version 6.0-lokal-wasm Copyright (c) the FFmpeg developers\n'

function toolOf(command) {
  const m = String(command || '').match(TOOL_RE)
  return m ? m[2].toLowerCase() : null
}

/** A ChildProcess look-alike. */
function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = new PassThrough()
  child.pid = 0
  child.exitCode = null
  child.killed = false
  child.finish = (code, signal = null) => {
    if (child.exitCode !== null || child._done) return
    child._done = true
    child.exitCode = code
    child.stdout.end()
    child.stderr.end()
    setImmediate(() => { child.emit('exit', code, signal); child.emit('close', code, signal) })
  }
  return child
}

// ------------------------------------------------------------------ ffmpeg
let worker = null
let workerReady = null
const queue = []
let current = null

function workerPath() {
  return path.join(__dirname, 'ffmpeg-worker.js')
}

function startWorker() {
  const { Worker } = require('worker_threads')
  worker = new Worker(workerPath())
  workerReady = new Promise((resolve, reject) => {
    const onMessage = (m) => {
      if (m && m.type === 'ready') { worker.off('message', onMessage); resolve() }
      if (m && m.type === 'fatal') { worker.off('message', onMessage); reject(new Error(m.error)) }
    }
    worker.on('message', onMessage)
  })
  worker.on('message', (m) => {
    if (!current || !m || m.id !== current.id) return
    if (m.type === 'log') current.child.stderr.write(m.line + '\n')
    else if (m.type === 'stdout') current.child.stdout.write(Buffer.from(m.data))
    else if (m.type === 'done') { const job = current; current = null; job.child.finish(m.code); pump() }
  })
  worker.on('error', (e) => {
    if (current) { current.child.stderr.write(`ffmpeg: ${e.message}\n`); current.child.finish(1); current = null }
    worker = null; workerReady = null
    pump()
  })
  worker.on('exit', () => { worker = null; workerReady = null })
}

let seq = 0
function pump() {
  if (current || !queue.length) return
  const job = queue.shift()
  if (job.child.killed) { job.child.finish(null, 'SIGKILL'); return pump() }
  current = job
  if (!worker) startWorker()
  workerReady.then(() => {
    if (current !== job) return
    worker.postMessage({ type: 'run', id: job.id, args: job.args, cwd: job.cwd })
  }, (e) => {
    job.child.stderr.write(`ffmpeg could not start: ${e.message}\n`)
    current = null
    job.child.finish(1)
    pump()
  })
}

function spawnFfmpeg(args, options = {}) {
  const child = fakeChild()
  const list = (args || []).map(String)
  if (list.includes('-version') || list.includes('--version')) {
    setImmediate(() => { child.stdout.write(VERSION_TEXT); child.finish(0) })
    return child
  }
  const job = { id: ++seq, args: list, cwd: options.cwd || process.cwd(), child }
  child.kill = () => {
    child.killed = true
    const i = queue.indexOf(job)
    if (i >= 0) { queue.splice(i, 1); child.finish(null, 'SIGKILL'); return true }
    if (current === job && worker) {
      // A running WebAssembly call can't be interrupted: drop the worker.
      current = null
      const w = worker
      worker = null; workerReady = null
      w.terminate().catch(() => {})
      child.finish(null, 'SIGKILL')
      pump()
      return true
    }
    return false
  }
  queue.push(job)
  setImmediate(pump)
  return child
}

// ----------------------------------------------------------------- ffprobe
const CODECS = [
  [/flac/i, 'flac'],
  [/alac|apple lossless/i, 'alac'],
  [/layer 3|mp3/i, 'mp3'],
  [/layer 2|mp2/i, 'mp2'],
  [/opus/i, 'opus'],
  [/vorbis/i, 'vorbis'],
  [/aac|mp4a/i, 'aac'],
  [/ac-?3/i, 'ac3'],
  [/wavpack/i, 'wavpack'],
  [/monkey|ape/i, 'ape'],
  [/wma/i, 'wmav2'],
]

function codecName(format = {}) {
  const text = `${format.codec || ''} ${format.container || ''}`
  if (/pcm|wave|wav|aiff/i.test(text) && !/adpcm/i.test(text)) {
    const bits = format.bitsPerSample || 16
    if (/float/i.test(text) || format.codecProfile === 'float') return 'pcm_f32le'
    return bits >= 24 ? 'pcm_s24le' : 'pcm_s16le'
  }
  for (const [re, name] of CODECS) if (re.test(text)) return name
  return String(format.codec || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

async function probe(file) {
  const mm = require('music-metadata')
  const meta = await mm.parseFile(file, { duration: true, skipCovers: true })
  const f = meta.format || {}
  const stream = {
    index: 0,
    codec_type: 'audio',
    codec_name: codecName(f),
    sample_rate: f.sampleRate ? String(f.sampleRate) : undefined,
    channels: f.numberOfChannels || 2,
    bits_per_raw_sample: f.bitsPerSample ? String(f.bitsPerSample) : undefined,
    bits_per_sample: f.bitsPerSample || 0,
    duration: f.duration != null ? String(f.duration) : undefined,
    bit_rate: f.bitrate ? String(Math.round(f.bitrate)) : undefined,
  }
  const stat = fs.statSync(file)
  return {
    streams: [stream],
    format: {
      filename: file,
      nb_streams: 1,
      format_name: String(f.container || '').toLowerCase(),
      duration: f.duration != null ? String(f.duration) : undefined,
      size: String(stat.size),
      bit_rate: f.bitrate ? String(Math.round(f.bitrate)) : undefined,
      tags: { title: meta.common?.title, artist: meta.common?.artist, album: meta.common?.album },
    },
  }
}

function spawnFfprobe(args) {
  const child = fakeChild()
  child.kill = () => { child.killed = true; child.finish(null, 'SIGKILL'); return true }
  const list = (args || []).map(String)
  setImmediate(async () => {
    if (list.includes('-version')) { child.stdout.write(VERSION_TEXT.replace('ffmpeg', 'ffprobe')); return child.finish(0) }
    // The input is the last argument that isn't an option or an option's value.
    const file = [...list].reverse().find(a => !a.startsWith('-') && fs.existsSync(a))
    if (!file) { child.stderr.write('ffprobe: no input file\n'); return child.finish(1) }
    try {
      const result = await probe(file)
      if (child.killed) return
      child.stdout.write(JSON.stringify(result, null, 2))
      child.finish(0)
    } catch (e) {
      child.stderr.write(`${file}: ${e.message}\n`)
      child.finish(1)
    }
  })
  return child
}

// -------------------------------------------------------------------- hooks
function cannotStart(command) {
  return Object.assign(new Error(`spawn ${command} EACCES`), { code: 'EACCES', errno: -13, syscall: `spawn ${command}`, path: command })
}

function install() {
  if (childProcess.__lokalTools) return
  childProcess.__lokalTools = true
  const original = { spawn: childProcess.spawn, execFile: childProcess.execFile, execFileSync: childProcess.execFileSync, spawnSync: childProcess.spawnSync }

  childProcess.spawn = function spawn(command, args, options) {
    if (!Array.isArray(args)) { options = args; args = [] }
    const tool = toolOf(command)
    if (tool === 'ffmpeg') return spawnFfmpeg(args, options)
    if (tool === 'ffprobe') return spawnFfprobe(args, options)
    return original.spawn.call(this, command, args, options)
  }

  childProcess.execFile = function execFile(command, args, options, callback) {
    if (typeof args === 'function') { callback = args; args = []; options = {} }
    else if (typeof options === 'function') { callback = options; options = {} }
    const tool = toolOf(command)
    if (!tool) return original.execFile.call(this, command, args, options, callback)
    const child = tool === 'ffmpeg' ? spawnFfmpeg(args, options) : spawnFfprobe(args, options)
    let out = '', err = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('close', (code) => {
      if (!callback) return
      if (code === 0) callback(null, out, err)
      else callback(Object.assign(new Error(err.trim().split('\n').pop() || `${tool} exited with ${code}`), { code }), out, err)
    })
    return child
  }

  // Only "is it installed?" checks are synchronous.
  childProcess.execFileSync = function execFileSync(command, args = [], options = {}) {
    const tool = toolOf(command)
    if (!tool) return original.execFileSync.call(this, command, args, options)
    if (Array.isArray(args) && (args.includes('-version') || args.includes('--version'))) {
      const text = tool === 'ffmpeg' ? VERSION_TEXT : VERSION_TEXT.replace('ffmpeg', 'ffprobe')
      return options && options.encoding && options.encoding !== 'buffer' ? text : Buffer.from(text)
    }
    throw cannotStart(command)
  }
  childProcess.spawnSync = function spawnSync(command, args = [], options = {}) {
    const tool = toolOf(command)
    if (!tool) return original.spawnSync.call(this, command, args, options)
    if (Array.isArray(args) && args.includes('-version')) {
      const text = Buffer.from(VERSION_TEXT)
      return { pid: 0, status: 0, signal: null, output: [null, text, Buffer.alloc(0)], stdout: text, stderr: Buffer.alloc(0) }
    }
    return { pid: 0, status: null, signal: null, output: null, stdout: null, stderr: null, error: cannotStart(command) }
  }
}

module.exports = { install, probe, codecName }
