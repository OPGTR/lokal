'use strict'
// A better-sqlite3 compatible layer over node-sqlite3-wasm (SQLite compiled to
// WebAssembly). Android's embedded Node.js can't load better-sqlite3's native
// addon, so the whole backend talks to this instead, unchanged.
//
// Covered: new Database(file), prepare() -> { run, get, all, iterate, raw },
// exec, transaction (with nesting via savepoints, .deferred/.immediate/
// .exclusive), pragma (incl. { simple: true }), function, close, open,
// inTransaction, name.
//
// WASM statements are not garbage collected, so prepared statements are kept
// in a per-SQL cache (one underlying statement per SQL text) instead of being
// created and leaked on every db.prepare(...).get() call.

const { Database: WasmDatabase } = require('node-sqlite3-wasm')

const CACHE_LIMIT = 400
const PARAM_RE = /([@:$])([A-Za-z_][A-Za-z0-9_]*)/g

class SqliteError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SqliteError'
    this.code = code || codeFromMessage(message)
  }
}

function codeFromMessage(message = '') {
  if (/UNIQUE constraint failed/i.test(message)) return 'SQLITE_CONSTRAINT_UNIQUE'
  if (/PRIMARY KEY/i.test(message) && /constraint/i.test(message)) return 'SQLITE_CONSTRAINT_PRIMARYKEY'
  if (/FOREIGN KEY constraint/i.test(message)) return 'SQLITE_CONSTRAINT_FOREIGNKEY'
  if (/NOT NULL constraint/i.test(message)) return 'SQLITE_CONSTRAINT_NOTNULL'
  if (/constraint failed/i.test(message)) return 'SQLITE_CONSTRAINT'
  if (/database is locked/i.test(message)) return 'SQLITE_BUSY'
  if (/no such table/i.test(message) || /no such column/i.test(message) || /syntax error/i.test(message)) return 'SQLITE_ERROR'
  return 'SQLITE_ERROR'
}

function wrapError(error) {
  if (error instanceof SqliteError) return error
  return new SqliteError(error?.message || String(error))
}

/** A value as better-sqlite3 would bind it. */
function toBindable(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.getTime()
  if (Buffer.isBuffer(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return value
}

/** A row value as better-sqlite3 returns it (blobs as Buffers). */
function fromColumn(value) {
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return value
}

function convertRow(row) {
  if (!row) return row
  for (const key of Object.keys(row)) {
    const value = row[key]
    if (value instanceof Uint8Array) row[key] = fromColumn(value)
  }
  return row
}

/** Splits better-sqlite3 style arguments into positional values and named ones. */
function splitArgs(args) {
  const positional = []
  let named = null
  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const v of arg) positional.push(toBindable(v))
    } else if (arg && typeof arg === 'object' && !(arg instanceof Uint8Array) && !Buffer.isBuffer(arg) && !(arg instanceof Date)) {
      named = Object.assign(named || {}, arg)
    } else {
      positional.push(toBindable(arg))
    }
  }
  return { positional, named }
}

const likeCache = new Map()
/** like(pattern, text, escape): LIKE with Unicode case folding. */
function unicodeLike(pattern, text, escape) {
  if (pattern == null || text == null) return null
  const key = `${escape ?? ''}\u0000${pattern}`
  let re = likeCache.get(key)
  if (!re) {
    const esc = escape == null ? null : String(escape)
    let source = ''
    const chars = Array.from(String(pattern).toLowerCase())
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]
      if (esc && c === esc && i + 1 < chars.length) { source += chars[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); continue }
      if (c === '%') source += '[^]*'
      else if (c === '_') source += '[^]'
      else source += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
    re = new RegExp(`^${source}$`, 'u')
    if (likeCache.size > 500) likeCache.clear()
    likeCache.set(key, re)
  }
  return re.test(String(text).toLowerCase()) ? 1 : 0
}

class Statement {
  constructor(db, sql) {
    this._db = db
    this.source = sql
    this._raw = false
    this._pluck = false
    // Named parameters used by this SQL, with their prefix: { name: '@name' }.
    this._params = null
    // Fail now (like better-sqlite3) when the SQL doesn't compile.
    db._statement(sql)
    this.reader = /^\s*(SELECT|WITH|PRAGMA|VALUES|EXPLAIN)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)
  }

  get database() { return this._db }

  raw(on = true) { this._raw = !!on; return this }
  pluck(on = true) { this._pluck = !!on; return this }
  expand() { return this }
  safeIntegers() { return this }
  bind() { throw new SqliteError('Statement.bind() is not supported on this platform') }

  _namedParams() {
    if (!this._params) {
      this._params = {}
      // Strip string literals so '@' inside text isn't mistaken for a parameter.
      const code = this.source.replace(/'(?:[^']|'')*'/g, "''")
      let m
      PARAM_RE.lastIndex = 0
      while ((m = PARAM_RE.exec(code))) {
        // Skip "::" casts / time strings like 12:30 (digits handled by regex).
        if (!(m[2] in this._params)) this._params[m[2]] = m[1] + m[2]
      }
    }
    return this._params
  }

  _values(args) {
    const { positional, named } = splitArgs(args)
    if (!named) return positional
    const map = this._namedParams()
    const object = {}
    for (const [key, value] of Object.entries(named)) {
      const param = map[key]
      if (param) object[param] = toBindable(value)
    }
    for (const name of Object.keys(map)) {
      if (!(map[name] in object)) throw new SqliteError(`Missing named parameter "${name}"`, 'SQLITE_RANGE')
    }
    if (!positional.length) return object
    return { __mixed: true, positional, object }
  }

  _bindOn(stmt, values) {
    if (values && values.__mixed) {
      // Positional "?" first, then names. Rare; bind by hand on the statement.
      if (!stmt._reset()) throw new SqliteError('Could not reset statement')
      values.positional.forEach((v, i) => stmt._bindValue(v, i + 1))
      stmt._bindObject(values.object)
      return undefined
    }
    return values
  }

  _shape(row) {
    if (!row) return row
    convertRow(row)
    if (this._pluck) return row[Object.keys(row)[0]]
    if (this._raw) return Object.values(row)
    return row
  }

  run(...args) {
    const db = this._db
    try {
      const stmt = db._statement(this.source)
      const values = this._values(args)
      let info
      if (values && values.__mixed) {
        this._bindOn(stmt, values)
        stmt._step()
        const r = db._wasm.get('SELECT changes() AS c, last_insert_rowid() AS id')
        info = { changes: r.c, lastInsertRowid: r.id }
      } else {
        info = stmt.run(values)
      }
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid }
    } catch (e) { throw wrapError(e) }
  }

  get(...args) {
    try {
      const stmt = this._db._statement(this.source)
      const values = this._values(args)
      let row
      if (values && values.__mixed) {
        this._bindOn(stmt, values)
        row = stmt._step() ? stmt._getRow(stmt._getColumnNames(), false) : null
      } else {
        row = stmt.get(values)
      }
      // Don't leave the statement mid-step: that keeps a read open.
      try { stmt._reset() } catch {}
      return row == null ? undefined : this._shape(row)
    } catch (e) { throw wrapError(e) }
  }

  all(...args) {
    try {
      const stmt = this._db._statement(this.source)
      const values = this._values(args)
      let rows
      if (values && values.__mixed) {
        this._bindOn(stmt, values)
        const cols = stmt._getColumnNames()
        rows = []
        while (stmt._step()) rows.push(stmt._getRow(cols, false))
      } else {
        rows = stmt.all(values)
      }
      return rows.map(row => this._shape(row))
    } catch (e) { throw wrapError(e) }
  }

  *iterate(...args) {
    // A dedicated statement: the loop body may run this same SQL again.
    let stmt
    try { stmt = this._db._wasm.prepare(this.source) } catch (e) { throw wrapError(e) }
    try {
      const values = this._values(args)
      let it
      if (values && values.__mixed) {
        this._bindOn(stmt, values)
        const cols = stmt._getColumnNames()
        it = (function* () { while (stmt._step()) yield stmt._getRow(cols, false) })()
      } else {
        it = stmt.iterate(values)
      }
      for (const row of it) yield this._shape(row)
    } finally {
      try { stmt.finalize() } catch {}
    }
  }

  columns() {
    try {
      const stmt = this._db._statement(this.source)
      return stmt._getColumnNames().map(name => ({ name, column: name, table: null, database: 'main', type: null }))
    } catch (e) { throw wrapError(e) }
  }
}

class Database {
  constructor(filename = ':memory:', options = {}) {
    this.name = filename
    this.memory = filename === ':memory:' || filename === ''
    this.readonly = !!options.readonly
    try {
      this._wasm = new WasmDatabase(this.memory ? ':memory:' : filename, {
        readOnly: !!options.readonly,
        fileMustExist: !!options.fileMustExist,
      })
    } catch (e) { throw wrapError(e) }
    this._cache = new Map()
    this._savepoint = 0
    // No shared memory in this VFS, so WAL isn't available; keep the journal
    // simple and tolerate the occasional concurrent request.
    try { this._wasm.exec('PRAGMA journal_mode = TRUNCATE; PRAGMA busy_timeout = 4000;') } catch {}
    // SQLite's LIKE only ignores case for A-Z: "été" wouldn't find "Été",
    // "группа" wouldn't find "Группа". LIKE ... ESCAPE (what the library
    // search uses) ignores case for every alphabet here.
    try { this._wasm.function('like', unicodeLike, { deterministic: true }) } catch {}
  }

  get open() { return !!this._wasm?.isOpen }
  get inTransaction() { return !!this._wasm?.inTransaction }

  _statement(sql) {
    let stmt = this._cache.get(sql)
    if (stmt && !stmt.isFinalized) {
      // Refresh LRU position.
      this._cache.delete(sql)
      this._cache.set(sql, stmt)
      return stmt
    }
    try { stmt = this._wasm.prepare(sql) } catch (e) { throw wrapError(e) }
    this._cache.set(sql, stmt)
    if (this._cache.size > CACHE_LIMIT) {
      const oldest = this._cache.keys().next().value
      const old = this._cache.get(oldest)
      this._cache.delete(oldest)
      try { old.finalize() } catch {}
    }
    return stmt
  }

  prepare(sql) {
    if (typeof sql !== 'string') throw new TypeError('Expected first argument to be a string')
    return new Statement(this, sql)
  }

  exec(sql) {
    try { this._wasm.exec(sql) } catch (e) { throw wrapError(e) }
    return this
  }

  pragma(source, options = {}) {
    const text = String(source).trim()
    // WAL needs shared memory the WASM VFS doesn't have.
    if (/^journal_mode\s*=\s*wal$/i.test(text)) return options.simple ? 'truncate' : [{ journal_mode: 'truncate' }]
    if (/^wal_checkpoint/i.test(text)) return options.simple ? 0 : [{ busy: 0, log: 0, checkpointed: 0 }]
    try {
      const rows = this._wasm.all(`PRAGMA ${text}`).map(convertRow)
      if (options.simple) {
        const first = rows[0]
        return first ? first[Object.keys(first)[0]] : undefined
      }
      return rows
    } catch (e) { throw wrapError(e) }
  }

  function(name, options, fn) {
    if (typeof options === 'function') { fn = options; options = {} }
    const wrapped = (...args) => {
      const result = fn(...args.map(fromColumn))
      return toBindable(result)
    }
    // SQLite registers the function for this many arguments (-1: any).
    Object.defineProperty(wrapped, 'length', { value: options?.varargs ? -1 : fn.length })
    try { this._wasm.function(name, wrapped, { deterministic: !!options?.deterministic }) } catch (e) { throw wrapError(e) }
    return this
  }

  aggregate() { throw new SqliteError('Custom aggregates are not supported on this platform') }
  loadExtension() { throw new SqliteError('Extensions are not supported on this platform') }
  unsafeMode() { return this }
  defaultSafeIntegers() { return this }

  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('Expected first argument to be a function')
    const make = (begin) => {
      const db = this
      const run = function (...args) {
        if (db.inTransaction) {
          const name = `lokal_sp_${++db._savepoint}`
          db._wasm.exec(`SAVEPOINT ${name}`)
          try {
            const result = fn.apply(this, args)
            db._wasm.exec(`RELEASE ${name}`)
            return result
          } catch (e) {
            try { db._wasm.exec(`ROLLBACK TO ${name}; RELEASE ${name}`) } catch {}
            throw e
          } finally { db._savepoint-- }
        }
        db._wasm.exec(begin)
        try {
          const result = fn.apply(this, args)
          db._wasm.exec('COMMIT')
          return result
        } catch (e) {
          try { if (db.inTransaction) db._wasm.exec('ROLLBACK') } catch {}
          throw e
        }
      }
      return run
    }
    const tx = make('BEGIN')
    tx.deferred = make('BEGIN DEFERRED')
    tx.immediate = make('BEGIN IMMEDIATE')
    tx.exclusive = make('BEGIN EXCLUSIVE')
    tx.default = tx
    return tx
  }

  close() {
    for (const stmt of this._cache.values()) { try { stmt.finalize() } catch {} }
    this._cache.clear()
    try { if (this._wasm.isOpen) this._wasm.close() } catch (e) { throw wrapError(e) }
    return this
  }
}

Database.SqliteError = SqliteError
module.exports = Database
module.exports.default = Database
module.exports.SqliteError = SqliteError
