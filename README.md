# SmartScan – Document Scanner & Manager

An offline-first Windows desktop app for scanning documents (CNIC, passports, certificates, receipts…), organizing them **by person**, and saving them as **real JPG and PDF files** on the drive you choose.

- Scan with a webcam, a USB/network scanner (WIA), your phone over Wi-Fi, or by importing image files.
- Edges are detected automatically and perspective is corrected. Each page keeps the document's **true proportions**: nothing is ever forced to A4.
- Files are stored as `Documents\<Person>\<Document>\<Document>_Page_01.jpg` plus `<Document>.pdf`, so you can open them straight from Windows Explorer.
- Changes made in Explorer (files added, renamed or deleted) sync back into the app.
- Multiple users on one PC. Each user has a separate, password-protected library.
- Nothing is uploaded anywhere. The only network access is the optional "Check for updates" button.

---

## 1. Running, testing, building

```bash
npm install
npm start                 # run the app in development
npm test                  # unit tests (library, sync, backup, accounts, phone bridge)
npm run test:e2e          # end-to-end: drives the real Electron app (on Linux, wrap with xvfb-run)
npm run dist:win          # Windows NSIS installer -> dist/SmartScan-Setup-<version>.exe
```

The Windows installer must be built **on Windows**, or by the included GitHub Actions workflow (`.github/workflows/build.yml`). The workflow runs all tests, builds the installer on `windows-latest`, uploads it as a build artifact, and publishes a GitHub Release when you push a `v*` tag. That release is also the source for in-app updates.

To regenerate the app icons from `src/renderer/assets/icon.svg`, run `npm run icons`.

### Installer behaviour
- Per-user install by default, so admin rights aren't needed. You can change the install folder.
- Creates a desktop shortcut and a Start-menu shortcut.
- **Start with Windows** is a setting inside the app. When enabled, SmartScan starts minimised to the taskbar.
- **Uninstall** removes the program files and the startup entry. It never deletes your documents or library folders.
- **Updates:** *Settings → Check for updates* downloads a newer release, then offers "Restart & install". An installer for a newer version can also be run over an existing install.

---

## 2. Technology choice: Electron vs Tauri

| Criterion | Electron (chosen) | Tauri |
|---|---|---|
| Webcam (`getUserMedia`) | Same Chromium everywhere, predictable | WebView2 works, but camera permission prompts vary |
| Database | **Built-in `node:sqlite`** (Node 24 inside Electron 45): real SQLite with **no native modules** | Rust `rusqlite` (needs a Rust toolchain) |
| Scanner (WIA) | PowerShell + WIA COM from Node, no add-ons | Possible via Rust COM crates; more code |
| Image processing | OpenCV.js (WASM) in a Web Worker | Same |
| Installer size | ~90–100 MB (bundles Chromium) | ~10 MB (uses system WebView2) |
| RAM at idle | ~150–200 MB | ~80–120 MB |
| Dev complexity | JS only | JS + Rust |

**Decision:** Electron. It makes camera, PDF printing and scanner integration the most reliable, and the whole codebase is plain JavaScript (no framework, no native add-ons, no bundler). Tauri would give a smaller installer, but at the cost of a Rust toolchain plus WebView2 differences between PCs.

**Runtime dependencies (6):**
- `pdf-lib`: PDF generation
- `@techstark/opencv-js`: edge detection and filters
- `qrcode`: QR code for the phone link
- `yazl` / `yauzl`: backup zip files
- `electron-updater`: in-app updates

**Low-spec PCs:**
- All image work runs in one Web Worker.
- Live detection runs on 480 px frames about 4 times a second.
- Thumbnails are cached on disk.
- Views are lazy-loaded.

---

## 3. Architecture

```
┌──────────────────────── Renderer (sandboxed, contextIsolation) ───────────────────────┐
│ app.js (router/shell) · views/* · scan/scan.js · scan/editor.js · components.js         │
│ worker/cv-worker.js  ← OpenCV.js (WASM): detect corners, warp, filters, encode JPEG     │
└───────────────▲ window.smartscan.call(channel, …)  (allow-listed preload bridge) ───────┘
                │ IPC (ids only – never file paths for library content)
┌───────────────┴──────────────────────── Main process (Node) ────────────────────────────┐
│ ipc.js       auth guard on every handler, dialogs, export/print/share, PDF preview       │
│ session.js   signed-in user + their open Library, relocate/locate/new library            │
│ accounts.js  system DB: users (scrypt hashes, lockout), remember-me tokens               │
│ library.js   per-user DB + files: collections, documents, pages, trash, export, stats    │
│ sync.js      reconcile DB ↔ disk, fs.watch(recursive), offline detection                 │
│ pdf.js       pdf-lib: one page per image, size from DPI or real ID-1/passport size       │
│ backup.js    .ssbackup zip (manifest + DB snapshot + files), safe restore                │
│ scanner.js   WIA through PowerShell (flatbed / feeder / scanner dialog)                  │
│ phone.js     temporary LAN page + token for phone-camera uploads                         │
│ storage.js   safe names, path-traversal guards, atomic writes, retries for locked files  │
│ main.js      app:// protocol (UI + user files), CSP, permissions, single instance        │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- **`app://smartscan/`** serves the UI and, under `/_data/<kind>/<id>`, the current user's files by database id. A different user's ids don't exist in the open library, so those requests return 404.
- The main window is blocked from making any `http(s)` request, so documents can't be sent out of the PC by the UI.

### Scanning pipeline
1. **Capture.** The camera grabs a full-resolution frame. Scanner, phone and imported images are used as they are.
2. **Detect.** The worker detects the document's corners, using:
   - colour-aware Canny edges (gray + R/G/B, so a blue card on a red desk is still found), plus brightness and saturation segmentation;
   - for each contour, the maximum-area 4-corner shape on its convex hull;
   - candidates **scored by how much of each side lies on a real edge**, not just by area.
3. **Crop.** You can adjust the crop with draggable corners and edge handles, with a magnifier.
4. **Warp.** The output size comes from the **true aspect ratio of the document**, estimated from its projected corners (Zhang & He 2007). A naive side-length estimate is the fallback. In E2E tests the recovered ratio is within 0.5–2% of the truth: a card photographed at an angle comes out card-shaped, and a certificate comes out at 0.709 against a true 0.707.
5. **Filters.**
   - Magic colour: removes shadows, keeps coloured areas and whitens paper.
   - Lighten, Grayscale, Black & white (shadow removal plus adaptive threshold), Original.
   - Optional "Remove shadows", brightness, contrast and "Sharpen text" (unsharp mask).
6. **Save.** The original capture is kept in `Database\originals`, so re-editing never degrades quality. The processed JPG is written, the PDF is rebuilt, and the thumbnail is cached.

---

## 4. Database design

### System database (one per PC): `%APPDATA%\SmartScan\smartscan-system.db`

| table | columns |
|---|---|
| `users` | id, username (unique, case-insensitive), display_name, password_hash (`scrypt$N$r$p$salt$hash`), folder_name, library_path, library_id, failed_attempts, locked_until, created_at, last_login_at |
| `sessions` | token_hash (SHA-256 of remember-me token), user_id → users, created_at, expires_at |

### Library database (one per user, inside their library): `Database\library.db`

| table | purpose / key columns |
|---|---|
| `collections` | Person or custom folder: name, kind (`person`\|`folder`), folder (on-disk name), notes, favorite, deleted_at, trash_folder |
| `documents` | collection_id → collections, title, doc_type, folder, pdf_file, pdf_status (`ok`/`stale`/`missing`/`none`), pdf_mode (`dpi`/`id1`/`passport`), pdf_dpi, pdf_compression, notes, favorite, source (`scan`/`imported`), deleted_at, trash_folder |
| `pages` | document_id → documents, position, file, managed (renamed by the app or not), original, width, height, file_size, mtime, sha256, phash (64-bit dHash), edit (JSON: quad, rotation, filter, adjustments), status (`ok`/`missing`) |
| `attachments` | Other PDFs found in a document folder (added in Explorer) |
| `tags`, `document_tags` | Many-to-many tags |
| `settings` | Per-user preferences (JPG quality, default filter, PDF defaults, theme…) |
| `activity` | Recent activity log (capped at 1000 rows) |
| `meta` | libraryId |

Schemas are versioned with `PRAGMA user_version` migrations. Journal mode is WAL, and foreign keys are on.

---

## 5. Local storage layout

```
<Chosen drive/folder>\SmartScan\Users\User_001_ali\
   .smartscan-library.json      ← marker: proves the folder belongs to this account
   README.txt
   Documents\
      Muhammad_Ali\
         CNIC\           CNIC_Page_01.jpg  CNIC_Page_02.jpg  CNIC.pdf
         Passport\       Passport_Page_01.jpg  Passport.pdf
      Ahmed_Khan\ …
   Trash\                ← folders deleted in the app (restorable), removed pages
   Backups\auto\         ← daily database snapshots (newest 10 kept)
   Database\             library.db, thumbs\ (cache), originals\ (untouched captures)
```

**Naming rules**
- Names are made Windows-safe: invalid characters are replaced, and reserved names (CON, NUL, …) and trailing dots are handled.
- Names are unique case-insensitively (`CNIC`, then `CNIC_2`, …).
- Renaming a person or document renames its folder and files.
- Reordering pages renumbers the files with a two-phase rename.
- Files you added yourself keep their names.

**Write safety**
- Every write goes to a temporary file, is fsync'd, then renamed over the target.
- If a file is locked (for example, a PDF open in Acrobat), the app retries, then marks the PDF `stale` instead of failing the scan.
- Writes are serialised with a mutex.

**Drives**
- On first run (registration) you choose a location; any internal, external or USB drive works.
- *Change location* copies the library, verifies the file count and size, checks free space first, and then switches over. The old copy is kept unless you choose otherwise.
- If the drive is missing at sign-in, or is disconnected while the app is running:
  - the status chip shows **Storage offline** and writes are blocked with a clear message;
  - a recovery screen offers *Retry*, *Locate library* (for when the drive letter changed; the marker id is checked) or *New library*.
  - Nothing is deleted.

## 6. Two-way synchronisation
- `fs.watch` (recursive) watches `Documents\`. A rescan also runs on demand (*Local Storage → Rescan now*) and every 10 minutes.
- **Added in Explorer:**
  - a new image in a document folder becomes a new page, and the PDF is rebuilt;
  - a new folder becomes a document;
  - a new top-level folder becomes a collection;
  - other PDFs become attachments.
- **Duplicates:** a file with the same SHA-256 as an existing page in that document is skipped.
- **Renames:**
  - a renamed page file is matched by SHA-256, preferring the file whose mtime matches (a rename keeps mtime, a copy doesn't);
  - renamed document and collection folders are matched by their content.
- **Deleted in Explorer:** pages are flagged as *missing*, not removed. You can then *Remove missing records* yourself. A deleted generated PDF is rebuilt.
- **Files still being copied** (modified less than 1.5 s ago) are picked up on the next pass.
- **Status chip:** Synced, Syncing, Needs attention (missing files) or Storage offline. A report lists everything the last pass found.

## 7. Security
- **Passwords:** scrypt (N=32768, r=8, p=1, 16-byte salt) with constant-time comparison.
- **Login lockout:** after 5 failed attempts, with increasing delays. Logins for unknown usernames take the same time as real ones, so usernames can't be discovered.
- **Remember-me:**
  - a random 256-bit token is created; only its SHA-256 is stored in the database;
  - the client copy is encrypted with Windows DPAPI (`safeStorage`);
  - all tokens are revoked when the password changes.
- **Library isolation:**
  - every IPC handler requires a signed-in session;
  - the renderer only passes ids;
  - the protocol handler only resolves ids from the open library;
  - the library marker stops anyone from pointing an account at another user's folder.
- **Paths and input:**
  - path-traversal guards on every path join;
  - image payloads are checked by their magic bytes (JPG/PNG), with size limits;
  - zip-slip protection and an entry allow-list when restoring backups.
- **Electron hardening:**
  - the renderer is sandboxed, with context isolation, a strict CSP and no `nodeIntegration`;
  - navigation and new windows are blocked;
  - only the camera permission is granted, and only to the app origin.
- **Phone link:**
  - off by default and only runs while the Phone tab is open;
  - uses a random token in the URL;
  - accepts JPG/PNG only, up to 30 MB;
  - stays on the local network.

> **Local-OS limitation:** a user's documents are ordinary files, as required, so another person who signs in to the same *Windows* account could open them in Explorer. App accounts separate libraries *inside SmartScan*. For OS-level protection, use separate Windows accounts or put the library on a BitLocker-encrypted drive.

## 8. Backup & restore
- **Backup:** creates one `.ssbackup` file (a zip) containing a manifest, a consistent `VACUUM INTO` database snapshot, the originals, the documents and, optionally, the Trash.
- **Restore:**
  1. The backup is validated and extracted to a temporary folder.
  2. Your current `Documents` and `Database` are **moved to `Restore_Previous_<date>`**, so nothing is lost.
  3. The restored data is moved into place and thumbnails are rebuilt.
  4. If anything fails, the previous state is put back.
- **Automatic DB backups:** taken daily and kept in `Backups\auto`. Any one of them can be restored from *Local Storage*, which then rescans your files.

## 9. Feature checklist

| Area | Implemented |
|---|---|
| Accounts | Register, login, logout, remember me, change password, display name, delete account (optionally recycle files), multiple users, lockout |
| Scanning | Webcam (choose camera and resolution), live edge overlay, auto-capture when steady, continuous multi-page capture, retake any page, WIA scanner (flatbed, feeder, scanner dialog, DPI/colour), phone camera via QR, image import (drag and drop) |
| Editing | Automatic and manual crop (corners and edges, magnifier), perspective correction, rotate left/right, Original / Magic colour / Lighten / Grayscale / B&W, remove shadows, brightness, contrast, sharpen, apply to all pages, preview before saving |
| Pages | Reorder (drag and drop), delete, retake/replace, insert more pages into existing documents; each page keeps its own size |
| Organisation | Collections (person or custom folder) with notes, documents with type, tags, notes and favourite; rename, move, delete, restore; search across names, titles, types, tags and notes; sort and filters |
| Export | JPG (original or chosen quality), PDF (stored or custom: page subset, order, real-size mode, compression), bulk export to a folder (JPG/PDF/both), PDF preview, print (single page, document or bulk) |
| Viewer | Zoom (buttons, Ctrl+wheel, keys), fit / 100%, full screen, next/prev, rotate (saved to file), download, print, rename, delete, share (Web Share where supported, otherwise copy the file to the clipboard), open file location, open in the default app |
| Storage | Choose drive, change location, open in Explorer, usage and free-space meter, offline/missing-drive handling, backup/restore, automatic DB backups, duplicate finder (exact and look-alike) |
| Desktop | NSIS installer, desktop and Start-menu shortcuts, start with Windows, single instance, window state remembered, offline, updates, clean uninstall |

## 10. Known limitations
- **Scanners:** WIA covers most USB and network scanners on Windows 10/11. TWAIN-only devices aren't driven directly; save from their own software and use *Import files*, or use the WIA dialog option. Scanning was implemented against the documented WIA API but **has not been tested on real scanner hardware** (development was on Linux CI).
- **Windows installer:** built by CI on `windows-latest`. Desktop shortcut and uninstall behaviour come from electron-builder's NSIS templates and were not tested by hand here. Code signing isn't configured, so Windows SmartScreen will warn until you add a signing certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`).
- **Phone camera:** works over plain HTTP on your LAN (the phone uses its own camera app), so the PC and phone must be on the same network. Windows Firewall will ask once.
- **System share sheet:** Electron doesn't expose the Windows share UI. Share uses the Web Share API where the runtime supports it, and otherwise copies the file to the clipboard (paste it into WhatsApp, Outlook or a folder).
- **Image formats:** HEIC photos can't be imported (convert them on the phone, or use the phone-camera link, which sends JPG).

## 11. Roadmap
- [x] Core library, file storage, sync engine, backup (unit-tested)
- [x] Accounts and security
- [x] Scanning pipeline (detection, perspective, filters) in a worker
- [x] Complete UI: dashboard, documents, collections, viewer, scan, storage, settings, trash
- [x] End-to-end tests against the dev and packaged app; Windows CI build
- [ ] OCR (searchable PDFs) using Tesseract WASM
- [ ] TWAIN support via a small native helper
- [ ] Optional encrypted libraries (password-derived key)
- [ ] Code-signing certificate for the installer
