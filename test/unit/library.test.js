'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Library } = require('../../src/main/library');
const { reconcile, removeMissing } = require('../../src/main/sync');
const backup = require('../../src/main/backup');
const S = require('../../src/main/storage');
const { pageSize } = require('../../src/main/pdf');
const { PDFDocument } = require('pdf-lib');
const { imaging, fixture, tmpDir } = require('./helpers');

function newLib(root = path.join(tmpDir(), 'SmartScan', 'Users', 'User_001_ali')) {
  return new Library({ root, userId: 1, libraryId: 'lib-1', username: 'ali' }, imaging).open();
}

test('safe names and path traversal protection', () => {
  assert.equal(S.safeSegment('Muhammad Ali'), 'Muhammad_Ali');
  assert.equal(S.safeSegment('  a<b>:c"d/e\\f|g?h*  '), 'a_b_c_d_e_f_g_h');
  assert.equal(S.safeSegment('CON'), '_CON');
  assert.equal(S.safeSegment('...'), 'Untitled');
  assert.equal(S.safeSegment('../../etc'), 'etc');
  assert.throws(() => S.resolveInside('/tmp/root', '../x'), /Invalid path/);
  assert.throws(() => S.resolveInside('/tmp/root', '/etc/passwd'), /Invalid path/);
  assert.equal(S.resolveInside('/tmp/root', 'a', 'b.jpg'), path.resolve('/tmp/root/a/b.jpg'));
});

test('PDF page sizes keep the real aspect ratio (never forced to A4)', () => {
  const [w, h] = pageSize(856, 540, { mode: 'id1' });
  assert.ok(Math.abs(w - 242.65) < 0.1);
  assert.ok(Math.abs(w / h - 856 / 540) < 1e-9);
  const [w2, h2] = pageSize(300, 1100, { mode: 'dpi', dpi: 150 });
  assert.equal(w2, 144); assert.ok(Math.abs(h2 - 528) < 1e-9);
});

test('collections, documents, real files and per-page PDF sizes', async () => {
  const lib = newLib();
  const col = await lib.createCollection({ name: 'Muhammad Ali' });
  assert.equal(col.folder, 'Muhammad_Ali');
  const doc = await lib.createDocument({ collectionId: col.id, title: 'CNIC', docType: 'CNIC', tags: ['id', 'urgent'],
    pages: [{ jpg: fixture('cnic.jpg'), original: fixture('cnic.jpg'), edit: { filter: 'enhance' } }, { jpg: fixture('passport.jpg') }] });
  const dir = path.join(lib.docsDir, 'Muhammad_Ali', 'CNIC');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['CNIC.pdf', 'CNIC_Page_01.jpg', 'CNIC_Page_02.jpg']);
  assert.equal(doc.pages.length, 2);
  assert.equal(doc.pages[0].width, 856);
  assert.deepEqual(doc.tags.sort(), ['id', 'urgent']);
  const pdf = await PDFDocument.load(fs.readFileSync(path.join(dir, 'CNIC.pdf')));
  const sizes = pdf.getPages().map((p) => p.getSize());
  assert.equal(sizes.length, 2);
  assert.ok(Math.abs(sizes[0].width / sizes[0].height - 856 / 540) < 0.001, 'page 1 keeps card ratio');
  assert.ok(Math.abs(sizes[1].width / sizes[1].height - 880 / 1250) < 0.001, 'page 2 keeps its own ratio');

  // reorder renames files to match the new order
  const reordered = await lib.reorderPages(doc.id, [doc.pages[1].id, doc.pages[0].id]);
  assert.equal(reordered.pages[0].id, doc.pages[1].id);
  assert.equal(reordered.pages[0].file, 'CNIC_Page_01.jpg');
  assert.equal(fs.readFileSync(path.join(dir, 'CNIC_Page_01.jpg')).length, fixture('passport.jpg').length);

  // add a page, then delete one (file goes to Trash, not erased)
  const added = await lib.addPages(doc.id, [{ jpg: fixture('receipt.jpg') }]);
  assert.equal(added.pages.length, 3);
  const afterDel = await lib.deletePages([added.pages[0].id]);
  assert.equal(afterDel.pages.length, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['CNIC.pdf', 'CNIC_Page_01.jpg', 'CNIC_Page_02.jpg']);
  assert.ok(fs.readdirSync(path.join(lib.trashDir, '_Removed_pages')).length > 0);

  // rename document and collection: folders/files follow
  await lib.updateDocument(doc.id, { title: 'CNIC Card' });
  assert.ok(fs.existsSync(path.join(lib.docsDir, 'Muhammad_Ali', 'CNIC_Card', 'CNIC_Card.pdf')));
  assert.ok(fs.existsSync(path.join(lib.docsDir, 'Muhammad_Ali', 'CNIC_Card', 'CNIC_Card_Page_01.jpg')));
  await lib.updateCollection(col.id, { name: 'M. Ali' });
  assert.ok(fs.existsSync(path.join(lib.docsDir, 'M._Ali', 'CNIC_Card', 'CNIC_Card.pdf')));

  // second document with same title gets a unique folder
  const doc2 = await lib.createDocument({ collectionId: col.id, title: 'CNIC Card', pages: [{ jpg: fixture('cnic.jpg') }] });
  assert.equal(doc2.folder, 'CNIC_Card_2');

  // search
  assert.equal(lib.listDocuments({ search: 'urgent' }).length, 1);
  assert.equal(lib.listCollections({ search: 'cnic' }).length, 1);

  // trash and restore
  await lib.deleteDocuments([doc2.id]);
  assert.ok(!fs.existsSync(path.join(lib.docsDir, 'M._Ali', 'CNIC_Card_2')));
  assert.equal(lib.listTrash().documents.length, 1);
  await lib.restoreDocuments([doc2.id]);
  assert.ok(fs.existsSync(path.join(lib.docsDir, 'M._Ali', 'CNIC_Card_2', 'CNIC_Card_2_Page_01.jpg')));

  // duplicates: doc2 page equals a page of doc
  assert.ok(lib.duplicates().some((g) => g.kind === 'exact'));

  // export
  const out = tmpDir('ss-export-');
  const res = await lib.exportDocuments([doc.id], out, { jpg: true, pdf: true });
  assert.equal(res.files, 3);

  const st = lib.stats();
  assert.equal(st.documents, 2); assert.equal(st.pages, 3); assert.equal(st.pdfFiles, 2);
  lib.close();
});

test('rejects invalid images and another user\'s library', async () => {
  const lib = newLib();
  const col = await lib.createCollection({ name: 'X' });
  await assert.rejects(lib.createDocument({ collectionId: col.id, title: 'Bad', pages: [{ jpg: Buffer.from('not an image at all') }] }), /valid JPG/);
  assert.equal(lib.listDocuments().length, 0);
  const root = lib.root; lib.close();
  const other = new Library({ root, userId: 2, libraryId: 'lib-2', username: 'eve' }, imaging);
  assert.throws(() => other.open(), /different SmartScan library/);
});

test('reconcile detects external adds, renames, deletes and duplicates', async () => {
  const lib = newLib();
  const col = await lib.createCollection({ name: 'Ahmed Khan' });
  const doc = await lib.createDocument({ collectionId: col.id, title: 'Passport', pages: [{ jpg: fixture('passport.jpg') }] });
  const dir = path.join(lib.docsDir, 'Ahmed_Khan', 'Passport');
  const old = Date.now() / 1000 - 60;

  // user drops a new image into the document folder, and a copy of an existing page
  fs.writeFileSync(path.join(dir, 'extra page.jpg'), fixture('receipt.jpg'));
  fs.copyFileSync(path.join(dir, 'Passport_Page_01.jpg'), path.join(dir, 'copy.jpg'));
  const older = old - 100;
  // user creates a new person folder with a document folder in Explorer
  fs.mkdirSync(path.join(lib.docsDir, 'Sara Malik', 'Degree'), { recursive: true });
  fs.writeFileSync(path.join(lib.docsDir, 'Sara Malik', 'Degree', 'scan1.jpg'), fixture('cnic.jpg'));
  fs.writeFileSync(path.join(lib.docsDir, 'Sara Malik', 'Degree', 'other.pdf'), '%PDF-1.4 test');
  for (const f of ['extra page.jpg', 'copy.jpg', 'Passport_Page_01.jpg']) fs.utimesSync(path.join(dir, f), f === 'copy.jpg' ? older : old, f === 'copy.jpg' ? older : old);
  fs.utimesSync(path.join(lib.docsDir, 'Sara Malik', 'Degree', 'scan1.jpg'), old, old);

  let r = await reconcile(lib);
  assert.equal(r.addedPages, 2);
  assert.deepEqual(r.addedCollections, ['Sara Malik']);
  assert.equal(r.duplicatesSkipped.length, 1);
  assert.equal(r.attachmentsAdded, 1);
  const d = lib.getDocument(doc.id);
  assert.equal(d.pages.length, 2);
  assert.equal(d.pages[1].file, 'extra page.jpg', 'user files keep their names');

  // idempotent: second run adds nothing
  r = await reconcile(lib);
  assert.equal(r.addedPages, 0); assert.equal(r.addedCollections.length, 0);

  // rename a page file and a collection folder in Explorer
  fs.renameSync(path.join(dir, 'Passport_Page_01.jpg'), path.join(dir, 'front.jpg'));
  r = await reconcile(lib);
  assert.equal(r.renamed.length, 1);
  assert.equal(lib.getDocument(doc.id).pages[0].file, 'front.jpg');
  fs.renameSync(path.join(lib.docsDir, 'Ahmed_Khan'), path.join(lib.docsDir, 'Ahmed_K'));
  r = await reconcile(lib);
  assert.ok(r.renamed.some((x) => x.includes('Ahmed_K')));
  assert.equal(lib.getCollection(col.id).folder, 'Ahmed_K');
  assert.equal(r.addedCollections.length, 0, 'renamed folder is not imported twice');

  // delete a file in Explorer: flagged missing, record kept until user removes it
  fs.rmSync(path.join(lib.docsDir, 'Ahmed_K', 'Passport', 'extra page.jpg'));
  r = await reconcile(lib);
  assert.equal(r.missingPages.length, 1);
  assert.equal(lib.getDocument(doc.id).pages.length, 2);
  assert.equal(await removeMissing(lib), 1);
  assert.equal(lib.getDocument(doc.id).pages.length, 1);

  // deleted PDF is regenerated
  fs.rmSync(path.join(lib.docsDir, 'Ahmed_K', 'Passport', 'Passport.pdf'));
  r = await reconcile(lib);
  assert.ok(fs.existsSync(path.join(lib.docsDir, 'Ahmed_K', 'Passport', 'Passport.pdf')));
  lib.close();
});

test('backup and restore round trip keeps previous data', async () => {
  const lib = newLib();
  const col = await lib.createCollection({ name: 'Backup Person' });
  await lib.createDocument({ collectionId: col.id, title: 'Doc A', pages: [{ jpg: fixture('cnic.jpg') }] });
  const file = path.join(tmpDir(), 'b.ssbackup');
  const res = await backup.createBackup(lib, file);
  assert.ok(res.size > 0);
  assert.equal((await backup.readManifest(file)).format, 'smartscan-backup');

  await lib.createDocument({ collectionId: col.id, title: 'Doc B', pages: [{ jpg: fixture('passport.jpg') }] });
  assert.equal(lib.listDocuments().length, 2);
  let current = lib;
  const r = await backup.restoreBackup(lib, file, {
    closeLibrary: async () => current.close(),
    reopenLibrary: async () => { current = new Library({ root: lib.root, userId: 1, libraryId: 'lib-1', username: 'ali' }, imaging).open(); return current; },
  });
  assert.equal(current.listDocuments().length, 1);
  assert.ok(fs.existsSync(path.join(r.previous, 'Documents', 'Backup_Person', 'Doc_B', 'Doc_B_Page_01.jpg')));
  assert.equal(backup.safeEntryName('../evil'), null);
  assert.equal(backup.safeEntryName('Documents/../../x'), null);
  assert.equal(backup.safeEntryName('Documents/a/b.jpg'), 'Documents/a/b.jpg');
  current.close();
});

test('accounts: hashing, lockout, remember token', async () => {
  const { Accounts } = require('../../src/main/accounts');
  const dir = tmpDir();
  const acc = new Accounts(dir);
  const u = await acc.register({ username: 'ali', password: 'secret123', baseDir: dir });
  assert.match(u.folderName, /^User_001_ali$/);
  const row = acc.getById(u.id);
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes('secret123'));
  await assert.rejects(acc.register({ username: 'ALI', password: 'secret123', baseDir: dir }), /taken/);
  await assert.rejects(acc.register({ username: 'bob', password: 'short', baseDir: dir }), /8 characters/);
  await assert.rejects(acc.login('ali', 'wrong-pass1'), /Invalid/);
  assert.equal((await acc.login('ali', 'secret123')).id, u.id);
  const tok = acc.createRememberToken(u.id);
  assert.equal(acc.consumeRememberToken(tok).id, u.id);
  await acc.changePassword(u.id, 'secret123', 'newpass456');
  assert.equal(acc.consumeRememberToken(tok), null, 'password change revokes sessions');
  for (let i = 0; i < 5; i++) await acc.login('ali', 'nope-1234').catch(() => {});
  await assert.rejects(acc.login('ali', 'newpass456'), /Too many/);
  const u2 = await acc.register({ username: 'sara', password: 'secret123', baseDir: dir });
  assert.notEqual(u2.libraryPath, u.libraryPath);
  acc.close();
});
