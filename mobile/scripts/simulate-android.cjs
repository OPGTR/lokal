'use strict'
// Preloaded (node -r) by the smoke test: makes a desktop Node 18 behave like
// the phone's nodejs-mobile build so problems show up before an APK exists.
//  - no ICU: no Intl, String#normalize is a no-op, TextDecoder knows only
//    UTF-8 / UTF-16LE, and \p{...} regexes fail to compile;
//  - process.platform is 'android';
//  - child processes can't be started (as for an app without binaries).
delete globalThis.Intl
Object.defineProperty(String.prototype, 'normalize', {
  configurable: true, writable: true,
  value: function normalize(form = 'NFC') {
    if (!['NFC', 'NFD', 'NFKC', 'NFKD'].includes(String(form))) throw new RangeError('Invalid normalization form')
    return String(this)
  },
})
const NativeDecoder = globalThis.TextDecoder
class LimitedDecoder extends NativeDecoder {
  constructor(encoding = 'utf-8', options) {
    const label = String(encoding).toLowerCase()
    if (!['utf-8', 'utf8', 'unicode-1-1-utf-8', 'utf-16le', 'utf-16'].includes(label)) throw new RangeError(`The "${encoding}" encoding is not supported`)
    super(encoding, options)
  }
}
globalThis.TextDecoder = LimitedDecoder
require('util').TextDecoder = LimitedDecoder

const NativeRegExp = RegExp
globalThis.RegExp = new Proxy(NativeRegExp, {
  construct(target, args) {
    const source = args[0] instanceof NativeRegExp ? args[0].source : String(args[0] ?? '')
    if (/\\[pP]\{/.test(source)) throw new SyntaxError(`Invalid regular expression: /${source}/: Invalid property name (no ICU)`)
    return Reflect.construct(target, args)
  },
  apply(target, thisArg, args) {
    const source = args[0] instanceof NativeRegExp ? args[0].source : String(args[0] ?? '')
    if (/\\[pP]\{/.test(source)) throw new SyntaxError(`Invalid regular expression: /${source}/: Invalid property name (no ICU)`)
    return Reflect.apply(target, thisArg, args)
  },
})

Object.defineProperty(process, 'platform', { value: 'android' })

const cp = require('child_process')
for (const name of ['spawn', 'execFile', 'exec', 'fork']) {
  const original = cp[name]
  cp[name] = function blocked(command, ...rest) {
    const { EventEmitter } = require('events')
    const child = new EventEmitter()
    child.stdout = new (require('stream').PassThrough)()
    child.stderr = new (require('stream').PassThrough)()
    child.stdin = new (require('stream').PassThrough)()
    child.kill = () => false
    child.pid = undefined
    const error = Object.assign(new Error(`spawn ${command} EACCES`), { code: 'EACCES', errno: -13, syscall: 'spawn ' + command })
    const callback = rest.find(a => typeof a === 'function')
    process.nextTick(() => {
      if (callback) callback(error, '', '')
      child.emit('error', error)
      child.stdout.end(); child.stderr.end()
    })
    return child
  }
  cp[name].original = original
}
for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
  cp[name] = function blocked(command) {
    if (name === 'spawnSync') return { pid: 0, status: null, signal: null, output: null, stdout: null, stderr: null, error: Object.assign(new Error(`spawnSync ${command} EACCES`), { code: 'EACCES' }) }
    throw Object.assign(new Error(`${name} ${command} EACCES`), { code: 'EACCES' })
  }
}
