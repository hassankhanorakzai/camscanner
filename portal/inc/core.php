<?php
/**
 * SmartScan portal core: database, auth, helpers.
 * The portal only relays END-TO-END ENCRYPTED data between office PCs and
 * paired phones. It never sees document contents or the encryption key.
 * Compatible with PHP 7.4+ and MySQL/MariaDB (SQLite is used for tests).
 */

define('SS_VERSION', '1.0.0');

function ss_config() {
  static $cfg = null;
  if ($cfg === null) {
    $file = getenv('SS_PORTAL_CONFIG') ?: dirname(__DIR__) . '/config.php';
    if (!file_exists($file)) ss_fail('Portal is not installed. Open install.php.', 503);
    $cfg = require $file;
  }
  return $cfg;
}

function ss_db() {
  static $pdo = null;
  if ($pdo === null) {
    $c = ss_config();
    $pdo = new PDO($c['dsn'], $c['db_user'] ?? null, $c['db_pass'] ?? null, [
      PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
      PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
      PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    if (ss_driver() === 'sqlite') $pdo->exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=4000;');
  }
  return $pdo;
}
function ss_driver() { return ss_db_driver_name(ss_config()['dsn']); }
function ss_db_driver_name($dsn) { return strtolower(substr($dsn, 0, strpos($dsn, ':'))); }

function ss_schema($driver) {
  $engine = $driver === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
  return [
    "CREATE TABLE IF NOT EXISTS ss_libraries (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      token_hash CHAR(64) NOT NULL,
      label VARCHAR(120) NOT NULL,
      created_at BIGINT NOT NULL,
      last_seen BIGINT NOT NULL DEFAULT 0,
      catalog_blob VARCHAR(40) NULL,
      catalog_version VARCHAR(80) NULL
    )$engine",
    "CREATE TABLE IF NOT EXISTS ss_devices (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      library_id VARCHAR(32) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      label VARCHAR(120) NOT NULL,
      created_at BIGINT NOT NULL,
      last_seen BIGINT NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0
    )$engine",
    "CREATE TABLE IF NOT EXISTS ss_pairings (
      code_hash CHAR(64) NOT NULL PRIMARY KEY,
      library_id VARCHAR(32) NOT NULL,
      expires_at BIGINT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )$engine",
    "CREATE TABLE IF NOT EXISTS ss_blobs (
      id VARCHAR(40) NOT NULL PRIMARY KEY,
      library_id VARCHAR(32) NOT NULL,
      size BIGINT NOT NULL,
      received BIGINT NOT NULL DEFAULT 0,
      complete INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    )$engine",
    "CREATE TABLE IF NOT EXISTS ss_thumbs (
      library_id VARCHAR(32) NOT NULL,
      page_id BIGINT NOT NULL,
      version BIGINT NOT NULL,
      blob_id VARCHAR(40) NOT NULL,
      PRIMARY KEY (library_id, page_id)
    )$engine",
    "CREATE TABLE IF NOT EXISTS ss_inbox (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      library_id VARCHAR(32) NOT NULL,
      device_id VARCHAR(32) NOT NULL,
      meta_blob VARCHAR(40) NOT NULL,
      page_blobs TEXT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      result TEXT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )$engine",
    "CREATE TABLE IF NOT EXISTS ss_requests (
      id VARCHAR(32) NOT NULL PRIMARY KEY,
      library_id VARCHAR(32) NOT NULL,
      device_id VARCHAR(32) NOT NULL,
      kind VARCHAR(16) NOT NULL,
      ref_id BIGINT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      blob_id VARCHAR(40) NULL,
      error VARCHAR(255) NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )$engine",
    "CREATE TABLE IF NOT EXISTS ss_attempts (
      ip VARCHAR(64) NOT NULL,
      at BIGINT NOT NULL
    )$engine",
  ];
}

// ------------------------------------------------------------ responses
function ss_json($data, $code = 200) {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode($data, JSON_UNESCAPED_SLASHES);
  exit;
}
function ss_fail($message, $code = 400) { ss_json(['ok' => false, 'error' => $message], $code); }
function ss_ok($data = []) { ss_json(array_merge(['ok' => true], $data)); }

function ss_input() {
  static $in = null;
  if ($in === null) {
    $raw = file_get_contents('php://input');
    $in = $raw ? json_decode($raw, true) : [];
    if (!is_array($in)) $in = [];
  }
  return $in;
}
function ss_param($k, $default = null) {
  $in = ss_input();
  if (isset($in[$k])) return $in[$k];
  if (isset($_GET[$k])) return $_GET[$k];
  return $default;
}

function ss_now() { return (int) round(microtime(true) * 1000); }
function ss_id($bytes = 12) { return bin2hex(random_bytes($bytes)); }
function ss_hash($s) { return hash('sha256', $s); }
function ss_valid_id($id) { return is_string($id) && preg_match('/^[a-f0-9]{16,40}$/', $id); }

function ss_q($sql, $params = []) {
  $st = ss_db()->prepare($sql);
  $st->execute($params);
  return $st;
}
function ss_row($sql, $params = []) { $r = ss_q($sql, $params)->fetch(); return $r ?: null; }

// ------------------------------------------------------------ auth
/** Token format: "pc.<libraryId>.<secret>" or "dv.<deviceId>.<secret>" sent in X-SS-Token. */
function ss_auth($need = null) {
  $tok = $_SERVER['HTTP_X_SS_TOKEN'] ?? '';
  if (!$tok && isset($_SERVER['HTTP_AUTHORIZATION']) && stripos($_SERVER['HTTP_AUTHORIZATION'], 'Bearer ') === 0) $tok = substr($_SERVER['HTTP_AUTHORIZATION'], 7);
  $parts = explode('.', $tok);
  if (count($parts) !== 3 || !ss_valid_id($parts[1])) ss_fail('Not signed in', 401);
  list($kind, $id, $secret) = $parts;
  if ($kind === 'pc') {
    $lib = ss_row('SELECT * FROM ss_libraries WHERE id = ?', [$id]);
    if (!$lib || !hash_equals($lib['token_hash'], ss_hash($secret))) ss_fail('Invalid PC token', 401);
    if ($need && $need !== 'pc') ss_fail('Forbidden', 403);
    ss_q('UPDATE ss_libraries SET last_seen = ? WHERE id = ?', [ss_now(), $id]);
    return ['kind' => 'pc', 'library_id' => $id, 'device_id' => null, 'library' => $lib];
  }
  if ($kind === 'dv') {
    $dev = ss_row('SELECT * FROM ss_devices WHERE id = ?', [$id]);
    if (!$dev || !hash_equals($dev['token_hash'], ss_hash($secret))) ss_fail('Invalid device token', 401);
    if ((int) $dev['revoked']) ss_fail('This phone was removed from the office PC. Pair it again.', 401);
    if ($need && $need !== 'device') ss_fail('Forbidden', 403);
    ss_q('UPDATE ss_devices SET last_seen = ? WHERE id = ?', [ss_now(), $id]);
    return ['kind' => 'device', 'library_id' => $dev['library_id'], 'device_id' => $id, 'device' => $dev];
  }
  ss_fail('Not signed in', 401);
}

function ss_client_ip() { return substr($_SERVER['REMOTE_ADDR'] ?? 'unknown', 0, 64); }
function ss_rate_limit($max, $windowSec) {
  $ip = ss_client_ip();
  $since = ss_now() - $windowSec * 1000;
  ss_q('DELETE FROM ss_attempts WHERE at < ?', [ss_now() - 86400000]);
  $n = (int) ss_row('SELECT COUNT(*) n FROM ss_attempts WHERE ip = ? AND at > ?', [$ip, $since])['n'];
  if ($n >= $max) ss_fail('Too many attempts. Wait a few minutes and try again.', 429);
  ss_q('INSERT INTO ss_attempts (ip, at) VALUES (?, ?)', [$ip, ss_now()]);
}

// ------------------------------------------------------------ blobs (encrypted data files)
function ss_blob_path($id) {
  if (!ss_valid_id($id)) ss_fail('Bad blob id');
  $dir = ss_config()['data_dir'] . '/' . substr($id, 0, 2);
  if (!is_dir($dir)) { @mkdir($dir, 0750, true); @file_put_contents($dir . '/index.html', ''); }
  return $dir . '/' . $id . '.bin';
}
function ss_blob_delete($id) {
  if (!$id || !ss_valid_id($id)) return;
  @unlink(ss_blob_path($id));
  ss_q('DELETE FROM ss_blobs WHERE id = ?', [$id]);
}
function ss_blob_require($id, $libraryId) {
  $b = ss_valid_id($id) ? ss_row('SELECT * FROM ss_blobs WHERE id = ? AND library_id = ?', [$id, $libraryId]) : null;
  if (!$b) ss_fail('File not found', 404);
  return $b;
}

/** Opportunistic housekeeping (shared hosting has no reliable cron). */
function ss_cleanup($force = false) {
  if (!$force && random_int(1, 40) !== 1) return;
  $ttl = (int) (ss_config()['blob_ttl_days'] ?? 7) * 86400000;
  $now = ss_now();
  foreach (ss_q("SELECT id FROM ss_blobs WHERE complete = 0 AND created_at < ?", [$now - 86400000])->fetchAll() as $b) ss_blob_delete($b['id']);
  foreach (ss_q("SELECT * FROM ss_requests WHERE updated_at < ? OR (status = 'done' AND updated_at < ?)", [$now - $ttl, $now - 3600000])->fetchAll() as $r) {
    ss_blob_delete($r['blob_id']);
    ss_q('DELETE FROM ss_requests WHERE id = ?', [$r['id']]);
  }
  foreach (ss_q("SELECT * FROM ss_inbox WHERE status <> 'pending' AND updated_at < ?", [$now - $ttl])->fetchAll() as $r) {
    ss_q('DELETE FROM ss_inbox WHERE id = ?', [$r['id']]);
  }
  ss_q('DELETE FROM ss_pairings WHERE expires_at < ?', [$now]);
}

function ss_str($s, $start, $len) { return function_exists("mb_substr") ? mb_substr((string) $s, $start, $len) : substr((string) $s, $start, $len); }
