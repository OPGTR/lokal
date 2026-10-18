'use strict'
// nodejs-mobile is built without ICU: no Intl, String#normalize returns its
// input unchanged, localeCompare is a plain code-unit compare and TextDecoder
// only knows UTF-8/UTF-16LE. The phone and the "server" are the same device,
// so local time is the user's time; these shims cover what Lokal and its
// dependencies use. Each one is installed only when the real thing is missing.

const unorm = require('unorm')

const hasIntl = typeof globalThis.Intl === 'object' && globalThis.Intl !== null

// ---------------------------------------------------------------- normalize
if (!hasIntl || 'é'.normalize('NFC') !== 'é') {
  const forms = { NFC: unorm.nfc, NFD: unorm.nfd, NFKC: unorm.nfkc, NFKD: unorm.nfkd }
  Object.defineProperty(String.prototype, 'normalize', {
    configurable: true,
    writable: true,
    value: function normalize(form = 'NFC') {
      const fn = forms[String(form)]
      if (!fn) throw new RangeError('The normalization form should be one of NFC, NFD, NFKC, NFKD.')
      return fn(String(this))
    },
  })
}

// ------------------------------------------------------------ localeCompare
const stripMarks = (s) => unorm.nfd(s).replace(/[̀-ͯ]/g, '')

function compareStrings(a, b, options = {}) {
  a = String(a); b = String(b)
  const sensitivity = options.sensitivity || 'variant'
  const key = (s) => {
    let k = s
    if (sensitivity === 'base' || sensitivity === 'accent') k = k.toLowerCase()
    if (sensitivity === 'base' || sensitivity === 'case') k = stripMarks(k)
    return k
  }
  let x = key(a), y = key(b)
  if (options.ignorePunctuation) { x = x.replace(/[\s!-/:-@[-`{-~]/g, ''); y = y.replace(/[\s!-/:-@[-`{-~]/g, '') }
  if (options.numeric) {
    const re = /(\d+)|(\D+)/g
    const xs = x.match(re) || [], ys = y.match(re) || []
    for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
      const p = xs[i], q = ys[i]
      if (/^\d/.test(p) && /^\d/.test(q)) {
        const d = Number(p) - Number(q)
        if (d) return d < 0 ? -1 : 1
      } else {
        const c = baseCompare(p, q)
        if (c) return c
      }
    }
    if (xs.length !== ys.length) return xs.length < ys.length ? -1 : 1
    return 0
  }
  return baseCompare(x, y)
}

// Accent- and case-insensitive first, then tie-break, like a real collator.
function baseCompare(x, y) {
  const bx = stripMarks(x).toLowerCase(), by = stripMarks(y).toLowerCase()
  if (bx !== by) return bx < by ? -1 : 1
  if (x === y) return 0
  return x < y ? -1 : 1
}

if (!hasIntl) {
  Object.defineProperty(String.prototype, 'localeCompare', {
    configurable: true,
    writable: true,
    value: function localeCompare(that, _locales, options) { return compareStrings(this, that, options || {}) },
  })
}

// --------------------------------------------------------------------- Intl
if (!hasIntl) {
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const localZone = () => process.env.TZ || 'UTC'

  class DateTimeFormat {
    constructor(locales, options = {}) {
      const zone = options.timeZone
      // Only the device's own zone (or UTC) can be honoured without ICU.
      if (zone && !/^(UTC|GMT|Etc\/UTC)$/i.test(zone) && zone !== localZone()) {
        throw new RangeError(`Invalid time zone specified: ${zone}`)
      }
      this._utc = !!zone && /^(UTC|GMT|Etc\/UTC)$/i.test(zone)
      this._locale = Array.isArray(locales) ? locales[0] : (locales || 'en-US')
      this._o = { ...options }
      if (!['year', 'month', 'day', 'hour', 'minute', 'second', 'weekday', 'dateStyle', 'timeStyle'].some(k => k in this._o)) {
        Object.assign(this._o, { year: 'numeric', month: 'numeric', day: 'numeric' })
      }
    }
    _fields(date) {
      const d = date == null ? new Date() : new Date(date)
      const g = this._utc
        ? { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() }
        : { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), wd: d.getDay() }
      return g
    }
    formatToParts(date) {
      const o = this._o, f = this._fields(date), parts = []
      const lit = (v) => parts.push({ type: 'literal', value: v })
      const dateParts = []
      if (o.weekday) dateParts.push({ type: 'weekday', value: o.weekday === 'long' ? DAYS[f.wd] : DAYS[f.wd].slice(0, 3) })
      const year = o.year ? { type: 'year', value: o.year === '2-digit' ? pad(f.y % 100) : String(f.y) } : null
      const month = o.month ? { type: 'month', value: o.month === 'long' ? MONTHS[f.m] : o.month === 'short' ? MONTHS[f.m].slice(0, 3) : o.month === '2-digit' ? pad(f.m + 1) : String(f.m + 1) } : null
      const day = o.day ? { type: 'day', value: o.day === '2-digit' ? pad(f.d) : String(f.d) } : null
      const iso = /^(en-CA|sv|lt|fr-CA)/i.test(this._locale)
      const ordered = iso ? [year, month, day] : /^en/i.test(this._locale) ? [month, day, year] : [day, month, year]
      const sep = iso ? '-' : '/'
      ordered.filter(Boolean).forEach((p, i, arr) => { parts.push(p); if (i < arr.length - 1) lit(sep) })
      if (dateParts.length) { parts.unshift(...dateParts, ...(parts.length ? [{ type: 'literal', value: ', ' }] : [])) }
      if (o.hour || o.minute || o.second || o.timeStyle) {
        if (parts.length) lit(', ')
        const h12 = o.hour12 === true || (o.hourCycle ? /h1[12]/.test(o.hourCycle) : false)
        const hour = h12 ? ((f.h % 12) || 12) : f.h
        parts.push({ type: 'hour', value: o.hour === 'numeric' && !h12 ? String(hour) : pad(hour) })
        if (o.minute || o.timeStyle) { lit(':'); parts.push({ type: 'minute', value: pad(f.mi) }) }
        if (o.second || o.timeStyle === 'medium' || o.timeStyle === 'long') { lit(':'); parts.push({ type: 'second', value: pad(f.s) }) }
        if (h12) { lit(' '); parts.push({ type: 'dayPeriod', value: f.h < 12 ? 'AM' : 'PM' }) }
      }
      return parts
    }
    format(date) { return this.formatToParts(date).map(p => p.value).join('') }
    formatRange(a, b) { return `${this.format(a)} – ${this.format(b)}` }
    resolvedOptions() { return { locale: this._locale, calendar: 'gregory', numberingSystem: 'latn', timeZone: this._utc ? 'UTC' : localZone(), ...this._o } }
    static supportedLocalesOf(l) { return Array.isArray(l) ? l : l ? [l] : [] }
  }

  class NumberFormat {
    constructor(locales, options = {}) { this._o = options; this._locale = Array.isArray(locales) ? locales[0] : (locales || 'en-US') }
    format(n) {
      const o = this._o
      let value = Number(n)
      if (!Number.isFinite(value)) return String(value)
      if (o.style === 'percent') value *= 100
      const max = o.maximumFractionDigits ?? (o.style === 'percent' ? 0 : 3)
      const min = o.minimumFractionDigits ?? 0
      let text = value.toFixed(Math.min(20, max))
      if (text.includes('.')) {
        text = text.replace(/0+$/, '')
        const [i, f = ''] = text.split('.')
        text = f.length < min ? `${i}.${f.padEnd(min, '0')}` : (f ? `${i}.${f}` : i)
      } else if (min) text = `${text}.${'0'.repeat(min)}`
      if (o.useGrouping !== false) text = text.replace(/^(-?\d+)/, (m) => m.replace(/\B(?=(\d{3})+(?!\d))/g, ','))
      if (o.style === 'percent') text += '%'
      if (o.style === 'currency' && o.currency) text = `${o.currency} ${text}`
      return text
    }
    formatToParts(n) { return [{ type: 'integer', value: this.format(n) }] }
    resolvedOptions() { return { locale: this._locale, numberingSystem: 'latn', ...this._o } }
    static supportedLocalesOf(l) { return Array.isArray(l) ? l : l ? [l] : [] }
  }

  class Collator {
    constructor(locales, options = {}) { this._o = options; this.compare = (a, b) => compareStrings(a, b, this._o) }
    resolvedOptions() { return { locale: 'en', usage: 'sort', sensitivity: 'variant', ...this._o } }
    static supportedLocalesOf(l) { return Array.isArray(l) ? l : l ? [l] : [] }
  }

  class PluralRules {
    constructor(locales, options = {}) { this._o = options }
    select(n) { return Number(n) === 1 ? 'one' : 'other' }
    resolvedOptions() { return { locale: 'en', ...this._o } }
    static supportedLocalesOf(l) { return Array.isArray(l) ? l : l ? [l] : [] }
  }

  class Segmenter {
    constructor(locales, options = {}) { this._g = options.granularity || 'grapheme' }
    segment(input) {
      const text = String(input)
      const out = []
      if (this._g === 'word') {
        const re = /[\p{L}\p{N}_'’]+|[^\p{L}\p{N}_'’]+/gu
        let m
        while ((m = re.exec(text))) out.push({ segment: m[0], index: m.index, input: text, isWordLike: /[\p{L}\p{N}]/u.test(m[0]) })
      } else if (this._g === 'sentence') {
        const re = /[^.!?]+[.!?]*\s*/g
        let m
        while ((m = re.exec(text))) out.push({ segment: m[0], index: m.index, input: text })
      } else {
        let i = 0
        for (const ch of text) {
          // Attach combining marks to the previous grapheme.
          if (out.length && /^[̀-ͯ‍️]$/.test(ch)) out[out.length - 1].segment += ch
          else out.push({ segment: ch, index: i, input: text })
          i += ch.length
        }
      }
      out.containing = (index) => out.find(s => index >= s.index && index < s.index + s.segment.length)
      return out
    }
  }

  class RelativeTimeFormat {
    constructor(locales, options = {}) { this._o = options }
    format(value, unit) {
      const n = Math.abs(Number(value))
      const u = String(unit).replace(/s$/, '') + (n === 1 ? '' : 's')
      return Number(value) < 0 ? `${n} ${u} ago` : `in ${n} ${u}`
    }
  }

  class ListFormat {
    constructor(locales, options = {}) { this._o = options }
    format(list) {
      const items = [...list].map(String)
      const word = this._o.type === 'disjunction' ? 'or' : 'and'
      if (items.length < 2) return items.join('')
      return `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`
    }
  }

  class DisplayNames {
    constructor(locales, options = {}) { this._o = options }
    of(code) { return code }
  }

  globalThis.Intl = {
    DateTimeFormat, NumberFormat, Collator, PluralRules, Segmenter, RelativeTimeFormat, ListFormat, DisplayNames,
    getCanonicalLocales: (l) => (Array.isArray(l) ? l : l ? [l] : []),
    supportedValuesOf: () => [],
  }

  const toLocaleDateString = Date.prototype.toLocaleDateString
  Date.prototype.toLocaleDateString = function (locales, options) {
    if (!locales && !options) return toLocaleDateString.call(this)
    return new DateTimeFormat(locales, options || { year: 'numeric', month: 'numeric', day: 'numeric' }).format(this)
  }
  const toLocaleTimeString = Date.prototype.toLocaleTimeString
  Date.prototype.toLocaleTimeString = function (locales, options) {
    if (!locales && !options) return toLocaleTimeString.call(this)
    return new DateTimeFormat(locales, options || { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(this)
  }
  Number.prototype.toLocaleString = function (locales, options) { return new NumberFormat(locales, options).format(this) }
}

// -------------------------------------------------------------- TextDecoder
// Without ICU only UTF-8 and UTF-16LE decode; add the legacy encodings tag
// readers and lyric files rely on.
;(() => {
  const Native = globalThis.TextDecoder
  if (!Native) return
  let needed = false
  try { new Native('windows-1251') } catch { needed = true }
  if (!needed) return

  const singleByte = {}
  const cp1252High = [0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
    0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178]
  const latin1 = new Array(256).fill(0).map((_, i) => i)
  const cp1252 = latin1.slice(); cp1252High.forEach((c, i) => { cp1252[0x80 + i] = c })
  const cp1251 = latin1.slice()
  const cp1251High = [0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x0409, 0x2039, 0x040a, 0x040c, 0x040b, 0x040f,
    0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0xfffd, 0x2122, 0x0459, 0x203a, 0x045a, 0x045c, 0x045b, 0x045f,
    0x00a0, 0x040e, 0x045e, 0x0408, 0x00a4, 0x0490, 0x00a6, 0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407,
    0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5, 0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb, 0x0458, 0x0405, 0x0455, 0x0457]
  cp1251High.forEach((c, i) => { cp1251[0x80 + i] = c })
  for (let i = 0xc0; i <= 0xff; i++) cp1251[i] = 0x0410 + (i - 0xc0)
  for (const name of ['latin1', 'iso-8859-1', 'iso8859-1', 'l1', 'ascii', 'us-ascii', 'windows-1252', 'cp1252', 'x-cp1252']) singleByte[name] = cp1252
  for (const name of ['windows-1251', 'cp1251', 'x-cp1251']) singleByte[name] = cp1251

  class TextDecoder {
    constructor(encoding = 'utf-8', options = {}) {
      const label = String(encoding).trim().toLowerCase()
      this.fatal = !!options.fatal
      this.ignoreBOM = !!options.ignoreBOM
      if (singleByte[label]) { this.encoding = label.includes('1251') ? 'windows-1251' : 'windows-1252'; this._table = singleByte[label] }
      else if (label === 'utf-16be' || label === 'unicodefffe') { this.encoding = 'utf-16be'; this._be = true }
      else { this._native = new Native(label, options); this.encoding = this._native.encoding }
    }
    decode(input, options) {
      if (this._native) return this._native.decode(input, options)
      if (input == null) return ''
      const bytes = input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input)
      if (this._be) {
        const swapped = Buffer.alloc(bytes.length - (bytes.length % 2))
        for (let i = 0; i + 1 < bytes.length; i += 2) { swapped[i] = bytes[i + 1]; swapped[i + 1] = bytes[i] }
        let text = swapped.toString('utf16le')
        if (!this.ignoreBOM && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
        return text
      }
      let out = ''
      for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192), b => this._table[b]))
      return out
    }
  }
  globalThis.TextDecoder = TextDecoder
  try { require('util').TextDecoder = TextDecoder } catch {}
})()
