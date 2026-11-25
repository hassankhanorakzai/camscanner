'use strict';
/**
 * Holds the signed-in user and their open library. All document operations go
 * through `session.lib`, which only ever sees the current user's folder.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Accounts } = require('./accounts');
const { Library, MARKER } = require('./library');
const { SyncEngine } = require('./sync');
const S = require('./storage');

class Session {
  constructor({ dataDir, config, imaging, defaultBase, notify }) {
    this.accounts = new Accounts(dataDir);
    this.config = config;
    this.imaging = imaging;
    this.defaultBase = defaultBase;
    this.notify = notify || (() => {});
    this.user = null;
    this.lib = null;
    this.sync = null;
    this.libState = null; // 'ok' | 'offline' | 'foreign' | 'error'
    this.libError = null;
  }

  status() {
    return {
      user: this.user, libState: this.libState, libError: this.libError,
      hasAccounts: this.accounts.count() > 0, defaultBase: this.defaultBase,
      sync: this.sync ? this.sync.state : null,
      knownUsers: this.config.get('showUserList', true) ? this.accounts.listPublic() : [],
      lastUsername: this.config.get('lastUsername', ''),
      showUserList: this.config.get('showUserList', true),
    };
  }

  async register(data) {
    const user = await this.accounts.register({ ...data, baseDir: data.baseDir || this.defaultBase });
    return this.startSession(user, !!data.remember);
  }

  async login({ username, password, remember }) {
    const user = await this.accounts.login(username, password);
    return this.startSession(user, !!remember);
  }

  async resume() {
    const token = this.config.getSecret('rememberToken');
    if (!token) return this.status();
    const user = this.accounts.consumeRememberToken(token);
    if (!user) { this.config.setSecret('rememberToken', null); return this.status(); }
    return this.startSession(user, false);
  }

  async startSession(user, remember) {
    await this.endLibrary();
    this.user = user;
    this.config.set('lastUsername', user.username);
    if (remember) {
      const old = this.config.getSecret('rememberToken');
      if (old) this.accounts.revokeToken(old);
      this.config.setSecret('rememberToken', this.accounts.createRememberToken(user.id));
    }
    this.openLibrary();
    return this.status();
  }

  openLibrary() {
    this.libError = null;
    try {
      const lib = new Library({ root: this.user.libraryPath, userId: this.user.id, libraryId: this.user.libraryId, username: this.user.username }, this.imaging).open();
      this.lib = lib;
      this.libState = 'ok';
      lib.listeners.add((evt) => this.notify('library:changed', { evt }));
      this.sync = new SyncEngine(lib, (state) => this.notify('sync:state', state));
      this.sync.start();
      try { if (lib.getSettings().autoBackup) lib.autoBackup(); } catch (e) { lib.log('error', `Automatic backup failed: ${e.message}`); }
    } catch (e) {
      this.lib = null;
      this.libState = e.code === 'STORAGE_OFFLINE' ? 'offline' : e.code === 'STORAGE_FOREIGN' ? 'foreign' : 'error';
      this.libError = e.message;
    }
    return this.status();
  }

  async endLibrary() {
    if (this.sync) { this.sync.stop(); this.sync = null; }
    if (this.lib) {
      await this.lib.lock.run(async () => {}); // wait for pending writes
      this.lib.close();
      this.lib = null;
    }
    this.libState = null;
  }

  async logout() {
    const token = this.config.getSecret('rememberToken');
    if (token) this.accounts.revokeToken(token);
    this.config.setSecret('rememberToken', null);
    await this.endLibrary();
    this.user = null;
    return this.status();
  }

  requireUser() {
    if (!this.user) throw new S.AppError('Please sign in.', 'AUTH_REQUIRED');
    return this.user;
  }
  requireLib() {
    this.requireUser();
    if (!this.lib) throw new S.AppError(this.libError || 'Your library is not available.', 'STORAGE_OFFLINE');
    return this.lib;
  }

  /** Close + reopen helpers for restore operations. */
  hooks() {
    return {
      closeLibrary: async () => { if (this.sync) { this.sync.stop(); this.sync = null; } if (this.lib) { this.lib.close(); this.lib = null; } },
      reopenLibrary: async () => { this.openLibrary(); if (!this.lib) throw new S.AppError(this.libError || 'Could not reopen library'); return this.lib; },
    };
  }

  /** Move or copy the whole library to another drive/folder. */
  async relocate(baseDir, { keepOld = true, onProgress } = {}) {
    const user = this.requireUser();
    if (!baseDir || !path.isAbsolute(baseDir)) throw new S.AppError('Choose a folder.');
    const target = Accounts.libraryPathFor(baseDir, user.folderName);
    const source = user.libraryPath;
    const rel = path.relative(source, target);
    if (path.resolve(target).toLowerCase() === path.resolve(source).toLowerCase()) throw new S.AppError('That is already the current location.');
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new S.AppError('The new location cannot be inside the current library.');
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new S.AppError(`The folder ${target} is not empty.`);
    if (!S.isReachable(source)) throw new S.AppError('The current library is not reachable, so it cannot be copied. Use "Locate library" instead.');
    const size = await S.dirSize(source);
    const free = await S.freeSpace(baseDir);
    if (free && free.free < size.bytes * 1.05 + 50e6) throw new S.AppError(`Not enough free space on the target drive (${Math.round(free.free / 1e6)} MB free, ${Math.round(size.bytes / 1e6)} MB needed).`);
    await this.endLibrary();
    try {
      let copied = 0;
      await fsp.mkdir(target, { recursive: true });
      await fsp.cp(source, target, {
        recursive: true, errorOnExist: false, force: false, preserveTimestamps: true,
        filter: (src) => { if (onProgress && ++copied % 50 === 0) onProgress(Math.min(0.99, copied / Math.max(1, size.files))); return true; },
      });
      const check = await S.dirSize(target);
      if (check.files < size.files || check.bytes < size.bytes) throw new S.AppError('Verification failed: not every file was copied. The old location is still in use.');
    } catch (e) {
      this.openLibrary();
      throw e;
    }
    this.user = this.accounts.setLibraryPath(user.id, target);
    let oldRemoved = false;
    if (!keepOld) {
      try { await fsp.rm(source, { recursive: true, force: true }); oldRemoved = true; } catch { oldRemoved = false; }
    }
    this.openLibrary();
    if (this.lib) this.lib.log('storage', `Library moved from ${source} to ${target}`);
    return { ...this.status(), oldPath: source, newPath: target, oldRemoved };
  }

  /** Point the account at an existing copy of its library (e.g. drive letter changed). */
  async locate(folder) {
    const user = this.requireUser();
    let root = folder;
    const candidates = [folder, Accounts.libraryPathFor(folder, user.folderName), path.join(folder, 'Users', user.folderName), path.join(folder, user.folderName)];
    root = candidates.find((c) => fs.existsSync(path.join(c, MARKER)));
    if (!root) throw new S.AppError('No SmartScan library was found in that folder.');
    const m = JSON.parse(fs.readFileSync(path.join(root, MARKER), 'utf8'));
    if (m.libraryId !== user.libraryId) throw new S.AppError('That folder contains a different user\'s library.');
    await this.endLibrary();
    this.user = this.accounts.setLibraryPath(user.id, root);
    return this.openLibrary();
  }

  /** Start an empty library elsewhere when the old drive is gone for good. */
  async createNewLibrary(baseDir) {
    const user = this.requireUser();
    const target = Accounts.libraryPathFor(baseDir, user.folderName);
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new S.AppError(`The folder ${target} is not empty.`);
    await this.endLibrary();
    const id = crypto.randomUUID();
    this.accounts.db.run('UPDATE users SET library_path=$p, library_id=$l WHERE id=$id', { p: target, l: id, id: user.id });
    this.user = { ...user, libraryPath: target, libraryId: id };
    return this.openLibrary();
  }

  async deleteAccount(password, { deleteFiles = false, removeFn } = {}) {
    const user = this.requireUser();
    await this.accounts.deleteAccount(user.id, password);
    const root = user.libraryPath;
    await this.logout();
    if (deleteFiles && fs.existsSync(path.join(root, MARKER))) await removeFn(root);
    return this.status();
  }
}

module.exports = { Session };
