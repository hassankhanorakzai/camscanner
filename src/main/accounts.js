'use strict';
/**
 * Accounts live in a small system database inside the app's data folder.
 * Each account owns a separate library folder (its own SQLite DB + files).
 */
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { Database, now } = require('./db');
const { AppError, safeSegment } = require('./storage');

const MIGRATIONS = [
  `CREATE TABLE users(
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     display_name TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     folder_name TEXT NOT NULL UNIQUE,
     library_path TEXT NOT NULL,
     library_id TEXT NOT NULL,
     failed_attempts INTEGER NOT NULL DEFAULT 0,
     locked_until INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     last_login_at INTEGER
   );
   CREATE TABLE sessions(
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );`,
];

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };
const REMEMBER_DAYS = 30;

function scrypt(password, salt, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, opts.keylen, { N: opts.N, r: opts.r, p: opts.p, maxmem: opts.maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), { N: +N, r: +r, p: +p, keylen: expected.length, maxmem: SCRYPT.maxmem });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function validateUsername(u) {
  const name = String(u || '').trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(name)) throw new AppError('Username must be 3–32 characters: letters, numbers, dot, dash or underscore.');
  return name;
}
function validatePassword(p) {
  const s = String(p || '');
  if (s.length < 8) throw new AppError('Password must be at least 8 characters.');
  if (s.length > 256) throw new AppError('Password is too long.');
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) throw new AppError('Password must contain both letters and numbers.');
  return s;
}

const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
const publicUser = (u) => u && ({ id: u.id, username: u.username, displayName: u.display_name, libraryPath: u.library_path, libraryId: u.library_id, folderName: u.folder_name, createdAt: u.created_at, lastLoginAt: u.last_login_at });

class Accounts {
  constructor(dataDir) {
    this.db = new Database(path.join(dataDir, 'smartscan-system.db'), MIGRATIONS);
    this.db.run('DELETE FROM sessions WHERE expires_at < $t', { t: now() });
  }

  count() { return this.db.get('SELECT COUNT(*) n FROM users').n; }
  getById(id) { return this.db.get('SELECT * FROM users WHERE id = $id', { id }); }
  listPublic() { return this.db.all('SELECT id, username, display_name FROM users ORDER BY last_login_at DESC NULLS LAST, username').map((u) => ({ id: u.id, username: u.username, displayName: u.display_name })); }

  /** Library root for a user: <base>/SmartScan/Users/<User_001_name> */
  static libraryPathFor(baseDir, folderName) { return path.join(baseDir, 'SmartScan', 'Users', folderName); }

  async register({ username, password, displayName, baseDir }) {
    const uname = validateUsername(username);
    validatePassword(password);
    if (!baseDir || !path.isAbsolute(baseDir)) throw new AppError('Please choose a storage location.');
    if (this.db.get('SELECT id FROM users WHERE username = $u', { u: uname })) throw new AppError('That username is already taken.');
    const hash = await hashPassword(password);
    const nextId = (this.db.get('SELECT COALESCE(MAX(id),0)+1 n FROM users').n);
    const folder = `User_${String(nextId).padStart(3, '0')}_${safeSegment(uname, 'user', 32)}`;
    const libPath = Accounts.libraryPathFor(baseDir, folder);
    if (fs.existsSync(libPath) && fs.readdirSync(libPath).length) throw new AppError(`A library folder already exists at ${libPath}. Choose another location.`);
    const libraryId = crypto.randomUUID();
    const r = this.db.run(`INSERT INTO users(id, username, display_name, password_hash, folder_name, library_path, library_id, created_at)
      VALUES($id,$u,$d,$h,$f,$p,$l,$t)`, { id: nextId, u: uname, d: String(displayName || uname).trim().slice(0, 80) || uname, h: hash, f: folder, p: libPath, l: libraryId, t: now() });
    return publicUser(this.getById(r.id));
  }

  async login(username, password) {
    const u = this.db.get('SELECT * FROM users WHERE username = $u', { u: String(username || '').trim() });
    if (!u) {
      await hashPassword('timing-equaliser'); // avoid user enumeration through timing
      throw new AppError('Invalid username or password.', 'BAD_LOGIN');
    }
    if (u.locked_until > now()) {
      throw new AppError(`Too many failed attempts. Try again in ${Math.ceil((u.locked_until - now()) / 1000)} seconds.`, 'LOCKED');
    }
    const ok = await verifyPassword(String(password || ''), u.password_hash);
    if (!ok) {
      const fails = u.failed_attempts + 1;
      const lock = fails >= 5 ? now() + Math.min(300, 30 * 2 ** (fails - 5)) * 1000 : 0;
      this.db.run('UPDATE users SET failed_attempts=$f, locked_until=$l WHERE id=$id', { f: fails, l: lock, id: u.id });
      throw new AppError('Invalid username or password.', 'BAD_LOGIN');
    }
    this.db.run('UPDATE users SET failed_attempts=0, locked_until=0, last_login_at=$t WHERE id=$id', { t: now(), id: u.id });
    return publicUser(this.getById(u.id));
  }

  createRememberToken(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.db.run('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES($h,$u,$c,$e)', { h: tokenHash(token), u: userId, c: now(), e: now() + REMEMBER_DAYS * 864e5 });
    return token;
  }
  consumeRememberToken(token) {
    if (!token) return null;
    const s = this.db.get('SELECT * FROM sessions WHERE token_hash=$h AND expires_at > $t', { h: tokenHash(token), t: now() });
    if (!s) return null;
    this.db.run('UPDATE users SET last_login_at=$t WHERE id=$id', { t: now(), id: s.user_id });
    return publicUser(this.getById(s.user_id));
  }
  revokeToken(token) { if (token) this.db.run('DELETE FROM sessions WHERE token_hash=$h', { h: tokenHash(token) }); }
  revokeAllTokens(userId) { this.db.run('DELETE FROM sessions WHERE user_id=$u', { u: userId }); }

  async changePassword(userId, current, next) {
    const u = this.getById(userId);
    if (!u || !(await verifyPassword(String(current || ''), u.password_hash))) throw new AppError('Current password is incorrect.');
    validatePassword(next);
    this.db.run('UPDATE users SET password_hash=$h WHERE id=$id', { h: await hashPassword(next), id: userId });
    this.revokeAllTokens(userId);
  }

  updateProfile(userId, { displayName }) {
    const d = String(displayName || '').trim().slice(0, 80);
    if (!d) throw new AppError('Display name cannot be empty.');
    this.db.run('UPDATE users SET display_name=$d WHERE id=$id', { d, id: userId });
    return publicUser(this.getById(userId));
  }

  setLibraryPath(userId, libPath) {
    this.db.run('UPDATE users SET library_path=$p WHERE id=$id', { p: libPath, id: userId });
    return publicUser(this.getById(userId));
  }

  async deleteAccount(userId, password) {
    const u = this.getById(userId);
    if (!u || !(await verifyPassword(String(password || ''), u.password_hash))) throw new AppError('Password is incorrect.');
    this.db.run('DELETE FROM users WHERE id=$id', { id: userId });
    return publicUser(u);
  }

  close() { this.db.close(); }
}

module.exports = { Accounts, hashPassword, verifyPassword, publicUser, validatePassword };
