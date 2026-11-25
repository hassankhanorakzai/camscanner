'use strict';
/** Thin wrapper around Node's built-in SQLite (no native modules needed). */
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

class Database {
  constructor(file, migrations) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 4000; PRAGMA synchronous = NORMAL;');
    this.cache = new Map();
    this.migrate(migrations || []);
  }

  migrate(migrations) {
    const current = this.db.prepare('PRAGMA user_version').get().user_version;
    for (let v = current; v < migrations.length; v++) {
      this.tx(() => {
        this.db.exec(migrations[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) { s = this.db.prepare(sql); this.cache.set(sql, s); }
    return s;
  }
  get(sql, params = {}) { const r = this.stmt(sql).get(params); return r ? { ...r } : undefined; }
  all(sql, params = {}) { return this.stmt(sql).all(params).map((r) => ({ ...r })); }
  run(sql, params = {}) { const r = this.stmt(sql).run(params); return { changes: Number(r.changes), id: Number(r.lastInsertRowid) }; }
  exec(sql) { this.db.exec(sql); }

  tx(fn) {
    if (this.inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally { this.inTx = false; }
  }

  /** Consistent online snapshot. */
  snapshot(target) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.rmSync(target);
    this.db.prepare('VACUUM INTO ?').run(target);
  }

  close() {
    if (!this.db) return;
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
    this.cache.clear();
    this.db.close();
    this.db = null;
  }
}

const now = () => Date.now();

module.exports = { Database, now };
