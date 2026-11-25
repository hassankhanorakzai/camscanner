<?php
/**
 * SmartScan portal API.  api.php?a=<action>
 * Office PCs authenticate with a PC token, phones with a device token
 * (both sent in the X-SS-Token header). Everything stored here is encrypted
 * by the PC/phone with a key the server never receives.
 */
require __DIR__ . '/inc/core.php';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') ss_ok();

$action = preg_replace('/[^a-z_.]/', '', strtolower($_GET['a'] ?? ''));

try {
  switch ($action) {
    // ---------------------------------------------------------------- public
    case 'ping':
      ss_ok(['app' => 'smartscan-portal', 'version' => SS_VERSION, 'time' => ss_now(), 'maxChunk' => ss_max_chunk()]);

    case 'pc.register': {
      ss_rate_limit(10, 600);
      $key = (string) ss_param('setupKey', '');
      $hash = ss_config()['setup_key_hash'] ?? '';
      if (!$hash || !hash_equals($hash, ss_hash($key))) ss_fail('Wrong office setup key.', 403);
      $label = trim(ss_str((string) ss_param('label', 'Office PC'), 0, 120)) ?: 'Office PC';
      $id = ss_id(12); $secret = bin2hex(random_bytes(24));
      ss_q('INSERT INTO ss_libraries (id, token_hash, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?)', [$id, ss_hash($secret), $label, ss_now(), ss_now()]);
      ss_ok(['libraryId' => $id, 'token' => "pc.$id.$secret"]);
    }

    case 'device.pair': {
      ss_rate_limit(15, 600);
      $code = strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string) ss_param('code', '')));
      $p = $code ? ss_row('SELECT * FROM ss_pairings WHERE code_hash = ?', [ss_hash($code)]) : null;
      if (!$p || (int) $p['used'] || $p['expires_at'] < ss_now()) ss_fail('This pairing code is invalid or expired. Show a new QR code on the PC.', 403);
      ss_q('UPDATE ss_pairings SET used = 1 WHERE code_hash = ?', [$p['code_hash']]);
      $label = trim(ss_str((string) ss_param('label', 'Phone'), 0, 120)) ?: 'Phone';
      $id = ss_id(12); $secret = bin2hex(random_bytes(24));
      ss_q('INSERT INTO ss_devices (id, library_id, token_hash, label, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)', [$id, $p['library_id'], ss_hash($secret), $label, ss_now(), ss_now()]);
      $lib = ss_row('SELECT label FROM ss_libraries WHERE id = ?', [$p['library_id']]);
      ss_ok(['deviceId' => $id, 'token' => "dv.$id.$secret", 'libraryId' => $p['library_id'], 'libraryLabel' => $lib['label'] ?? '']);
    }

    // ---------------------------------------------------------------- office PC
    case 'pc.status': {
      $a = ss_auth('pc');
      $devices = ss_q('SELECT id, label, created_at, last_seen, revoked FROM ss_devices WHERE library_id = ? AND revoked = 0 ORDER BY created_at', [$a['library_id']])->fetchAll();
      $active = 0;
      foreach ($devices as &$d) { $d['created_at'] = (int) $d['created_at']; $d['last_seen'] = (int) $d['last_seen']; if ($d['last_seen'] > ss_now() - 120000) $active++; }
      $inbox = (int) ss_row("SELECT COUNT(*) n FROM ss_inbox WHERE library_id = ? AND status = 'pending'", [$a['library_id']])['n'];
      $req = (int) ss_row("SELECT COUNT(*) n FROM ss_requests WHERE library_id = ? AND status = 'pending'", [$a['library_id']])['n'];
      ss_cleanup();
      ss_ok(['label' => $a['library']['label'], 'devices' => $devices, 'activeDevices' => $active, 'pendingInbox' => $inbox, 'pendingRequests' => $req, 'catalogVersion' => $a['library']['catalog_version'], 'maxChunk' => ss_max_chunk()]);
    }

    case 'pc.pairing': {
      $a = ss_auth('pc');
      $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      $code = '';
      for ($i = 0; $i < 10; $i++) $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
      ss_q('INSERT INTO ss_pairings (code_hash, library_id, expires_at) VALUES (?, ?, ?)', [ss_hash($code), $a['library_id'], ss_now() + 15 * 60000]);
      ss_ok(['code' => $code, 'expiresAt' => ss_now() + 15 * 60000]);
    }

    case 'pc.revoke': {
      $a = ss_auth('pc');
      $id = (string) ss_param('deviceId', '');
      if ($id === '*') ss_q('UPDATE ss_devices SET revoked = 1 WHERE library_id = ?', [$a['library_id']]);
      else ss_q('UPDATE ss_devices SET revoked = 1 WHERE id = ? AND library_id = ?', [$id, $a['library_id']]);
      ss_ok();
    }

    case 'pc.rename': {
      $a = ss_auth('pc');
      $label = trim(ss_str((string) ss_param('label', ''), 0, 120));
      if ($label) ss_q('UPDATE ss_libraries SET label = ? WHERE id = ?', [$label, $a['library_id']]);
      ss_ok();
    }

    case 'pc.catalog': {
      $a = ss_auth('pc');
      $blob = (string) ss_param('blobId', '');
      ss_blob_require($blob, $a['library_id']);
      $old = $a['library']['catalog_blob'];
      ss_q('UPDATE ss_libraries SET catalog_blob = ?, catalog_version = ? WHERE id = ?', [$blob, ss_str((string) ss_param('version', ''), 0, 80), $a['library_id']]);
      if ($old && $old !== $blob) ss_blob_delete($old);
      ss_ok();
    }

    case 'pc.thumbs': {
      $a = ss_auth('pc');
      $have = [];
      foreach (ss_q('SELECT page_id, version FROM ss_thumbs WHERE library_id = ?', [$a['library_id']])->fetchAll() as $t) $have[(string) $t['page_id']] = (int) $t['version'];
      ss_ok(['thumbs' => (object) $have]);
    }

    case 'pc.thumb_set': {
      $a = ss_auth('pc');
      $pageId = (int) ss_param('pageId', 0); $version = (int) ss_param('version', 0); $blob = (string) ss_param('blobId', '');
      ss_blob_require($blob, $a['library_id']);
      $old = ss_row('SELECT blob_id FROM ss_thumbs WHERE library_id = ? AND page_id = ?', [$a['library_id'], $pageId]);
      ss_q('DELETE FROM ss_thumbs WHERE library_id = ? AND page_id = ?', [$a['library_id'], $pageId]);
      ss_q('INSERT INTO ss_thumbs (library_id, page_id, version, blob_id) VALUES (?, ?, ?, ?)', [$a['library_id'], $pageId, $version, $blob]);
      if ($old && $old['blob_id'] !== $blob) ss_blob_delete($old['blob_id']);
      ss_ok();
    }

    case 'pc.thumbs_prune': {
      $a = ss_auth('pc');
      $keep = array_map('intval', (array) ss_param('pageIds', []));
      foreach (ss_q('SELECT page_id, blob_id FROM ss_thumbs WHERE library_id = ?', [$a['library_id']])->fetchAll() as $t) {
        if (!in_array((int) $t['page_id'], $keep, true)) {
          ss_blob_delete($t['blob_id']);
          ss_q('DELETE FROM ss_thumbs WHERE library_id = ? AND page_id = ?', [$a['library_id'], $t['page_id']]);
        }
      }
      ss_ok();
    }

    case 'pc.inbox': {
      $a = ss_auth('pc');
      $rows = ss_q("SELECT id, device_id, meta_blob, page_blobs, created_at FROM ss_inbox WHERE library_id = ? AND status = 'pending' ORDER BY created_at LIMIT 20", [$a['library_id']])->fetchAll();
      foreach ($rows as &$r) { $r['page_blobs'] = json_decode($r['page_blobs'], true) ?: []; $r['created_at'] = (int) $r['created_at']; }
      ss_ok(['items' => $rows]);
    }

    case 'pc.inbox_done': {
      $a = ss_auth('pc');
      $id = (string) ss_param('id', '');
      $item = ss_row('SELECT * FROM ss_inbox WHERE id = ? AND library_id = ?', [$id, $a['library_id']]);
      if (!$item) ss_fail('Not found', 404);
      $status = ss_param('status') === 'error' ? 'error' : 'done';
      ss_q('UPDATE ss_inbox SET status = ?, result = ?, updated_at = ? WHERE id = ?', [$status, ss_str((string) ss_param('result', ''), 0, 60000), ss_now(), $id]);
      // uploaded pages are no longer needed once the PC saved them
      ss_blob_delete($item['meta_blob']);
      foreach ((json_decode($item['page_blobs'], true) ?: []) as $b) ss_blob_delete($b);
      ss_ok();
    }

    case 'pc.requests': {
      $a = ss_auth('pc');
      $rows = ss_q("SELECT id, device_id, kind, ref_id, created_at FROM ss_requests WHERE library_id = ? AND status = 'pending' ORDER BY created_at LIMIT 20", [$a['library_id']])->fetchAll();
      foreach ($rows as &$r) { $r['ref_id'] = (int) $r['ref_id']; $r['created_at'] = (int) $r['created_at']; }
      ss_ok(['items' => $rows]);
    }

    case 'pc.request_done': {
      $a = ss_auth('pc');
      $id = (string) ss_param('id', '');
      $r = ss_row('SELECT * FROM ss_requests WHERE id = ? AND library_id = ?', [$id, $a['library_id']]);
      if (!$r) ss_fail('Not found', 404);
      $blob = ss_param('blobId');
      if ($blob) { ss_blob_require($blob, $a['library_id']); ss_q("UPDATE ss_requests SET status = 'ready', blob_id = ?, updated_at = ? WHERE id = ?", [$blob, ss_now(), $id]); }
      else ss_q("UPDATE ss_requests SET status = 'error', error = ?, updated_at = ? WHERE id = ?", [ss_str((string) ss_param('error', 'Not available'), 0, 250), ss_now(), $id]);
      ss_ok();
    }

    // ---------------------------------------------------------------- phone
    case 'dv.status': {
      $a = ss_auth('device');
      $lib = ss_row('SELECT label, last_seen, catalog_blob, catalog_version FROM ss_libraries WHERE id = ?', [$a['library_id']]);
      $thumbs = [];
      foreach (ss_q('SELECT page_id, version, blob_id FROM ss_thumbs WHERE library_id = ?', [$a['library_id']])->fetchAll() as $t) $thumbs[(string) $t['page_id']] = [(int) $t['version'], $t['blob_id']];
      ss_cleanup();
      ss_ok(['label' => $lib['label'], 'pcLastSeen' => (int) $lib['last_seen'], 'catalogBlob' => $lib['catalog_blob'], 'catalogVersion' => $lib['catalog_version'], 'thumbs' => (object) $thumbs, 'deviceLabel' => $a['device']['label'], 'maxChunk' => ss_max_chunk()]);
    }

    case 'dv.submit': {
      $a = ss_auth('device');
      $meta = (string) ss_param('metaBlob', '');
      ss_blob_require($meta, $a['library_id']);
      $pages = array_values(array_filter((array) ss_param('pageBlobs', []), 'ss_valid_id'));
      foreach ($pages as $p) ss_blob_require($p, $a['library_id']);
      if (count($pages) > 200) ss_fail('Too many pages');
      $id = ss_id(12);
      ss_q('INSERT INTO ss_inbox (id, library_id, device_id, meta_blob, page_blobs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [$id, $a['library_id'], $a['device_id'], $meta, json_encode($pages), ss_now(), ss_now()]);
      ss_ok(['id' => $id]);
    }

    case 'dv.submissions': {
      $a = ss_auth('device');
      $ids = array_values(array_filter((array) ss_param('ids', []), 'ss_valid_id'));
      $out = [];
      foreach ($ids as $id) {
        $r = ss_row('SELECT id, status, result, updated_at FROM ss_inbox WHERE id = ? AND device_id = ?', [$id, $a['device_id']]);
        $out[$id] = $r ? ['status' => $r['status'], 'result' => $r['result'], 'updatedAt' => (int) $r['updated_at']] : ['status' => 'unknown'];
      }
      ss_ok(['items' => (object) $out]);
    }

    case 'dv.request': {
      $a = ss_auth('device');
      $kind = ss_param('kind') === 'page' ? 'page' : 'pdf';
      $ref = (int) ss_param('refId', 0);
      if ($ref <= 0) ss_fail('Bad request');
      // reuse a pending/ready request for the same file
      $r = ss_row("SELECT id FROM ss_requests WHERE device_id = ? AND kind = ? AND ref_id = ? AND status IN ('pending','ready') AND updated_at > ?", [$a['device_id'], $kind, $ref, ss_now() - 3600000]);
      if ($r) ss_ok(['id' => $r['id']]);
      $id = ss_id(12);
      ss_q('INSERT INTO ss_requests (id, library_id, device_id, kind, ref_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [$id, $a['library_id'], $a['device_id'], $kind, $ref, ss_now(), ss_now()]);
      ss_ok(['id' => $id]);
    }

    case 'dv.request_status': {
      $a = ss_auth('device');
      $r = ss_row('SELECT id, status, blob_id, error FROM ss_requests WHERE id = ? AND device_id = ?', [(string) ss_param('id', ''), $a['device_id']]);
      if (!$r) ss_fail('Not found', 404);
      ss_ok(['status' => $r['status'], 'blobId' => $r['blob_id'], 'error' => $r['error']]);
    }

    case 'dv.request_done': {
      $a = ss_auth('device');
      $r = ss_row('SELECT * FROM ss_requests WHERE id = ? AND device_id = ?', [(string) ss_param('id', ''), $a['device_id']]);
      if ($r) { ss_blob_delete($r['blob_id']); ss_q("UPDATE ss_requests SET status = 'done', blob_id = NULL, updated_at = ? WHERE id = ?", [ss_now(), $r['id']]); }
      ss_ok();
    }

    case 'dv.unpair': {
      $a = ss_auth('device');
      ss_q('UPDATE ss_devices SET revoked = 1 WHERE id = ?', [$a['device_id']]);
      ss_ok();
    }

    // ---------------------------------------------------------------- encrypted blobs (PC + phone)
    case 'blob.create': {
      $a = ss_auth();
      $size = (int) ss_param('size', 0);
      $max = (int) (ss_config()['max_blob_mb'] ?? 60) * 1048576;
      if ($size <= 0 || $size > $max) ss_fail('File too large for the portal (limit ' . ($max / 1048576) . ' MB).', 413);
      $id = ss_id(16);
      ss_q('INSERT INTO ss_blobs (id, library_id, size, created_at) VALUES (?, ?, ?, ?)', [$id, $a['library_id'], $size, ss_now()]);
      file_put_contents(ss_blob_path($id), '');
      ss_ok(['id' => $id]);
    }

    case 'blob.append': {
      $a = ss_auth();
      $b = ss_blob_require((string) ($_GET['id'] ?? ''), $a['library_id']);
      if ((int) $b['complete']) ss_fail('Already complete', 409);
      $offset = (int) ($_GET['offset'] ?? -1);
      if ($offset !== (int) $b['received']) ss_json(['ok' => false, 'error' => 'Offset mismatch', 'received' => (int) $b['received']], 409);
      $data = file_get_contents('php://input');
      $len = strlen($data);
      if ($len === 0 || $offset + $len > (int) $b['size']) ss_fail('Bad chunk');
      $fh = fopen(ss_blob_path($b['id']), 'c');
      fseek($fh, $offset); fwrite($fh, $data); fflush($fh); fclose($fh);
      $received = $offset + $len;
      $complete = $received === (int) $b['size'] ? 1 : 0;
      ss_q('UPDATE ss_blobs SET received = ?, complete = ? WHERE id = ?', [$received, $complete, $b['id']]);
      ss_ok(['received' => $received, 'complete' => (bool) $complete]);
    }

    case 'blob.get': {
      $a = ss_auth();
      $b = ss_blob_require((string) ($_GET['id'] ?? ''), $a['library_id']);
      if (!(int) $b['complete']) ss_fail('Upload not finished', 409);
      $file = ss_blob_path($b['id']);
      if (!is_file($file)) ss_fail('File not found', 404);
      header('Content-Type: application/octet-stream');
      header('Content-Length: ' . filesize($file));
      header('Cache-Control: private, max-age=31536000, immutable');
      readfile($file);
      exit;
    }

    case 'blob.delete': {
      $a = ss_auth();
      ss_blob_require((string) ss_param('id', ''), $a['library_id']);
      ss_blob_delete((string) ss_param('id', ''));
      ss_ok();
    }

    default:
      ss_fail('Unknown action', 404);
  }
} catch (PDOException $e) {
  error_log('[smartscan] ' . $e->getMessage());
  ss_fail('Database error on the portal. Check the portal configuration.', 500);
}

/** Largest chunk the hosting accepts in one request (post_max_size), capped at 2 MB. */
function ss_max_chunk() {
  $v = ini_get('post_max_size') ?: '8M';
  $n = (int) $v; $u = strtoupper(substr(trim($v), -1));
  $bytes = $u === 'G' ? $n * 1073741824 : ($u === 'M' ? $n * 1048576 : ($u === 'K' ? $n * 1024 : $n));
  if ($bytes <= 0) $bytes = 8388608;
  return max(262144, min(2097152, (int) ($bytes * 0.8)));
}
