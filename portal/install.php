<?php
/**
 * SmartScan portal installer. Upload the portal folder, open install.php in a
 * browser, enter the MySQL details from cPanel/hPanel, done.
 */
require __DIR__ . '/inc/core.php';

$configFile = __DIR__ . '/config.php';
$installed = file_exists($configFile);
$errors = [];
$checks = [
  'PHP 7.4 or newer' => version_compare(PHP_VERSION, '7.4.0', '>='),
  'PDO MySQL extension' => extension_loaded('pdo_mysql'),
  'OpenSSL / random_bytes' => function_exists('random_bytes'),
  'Portal folder is writable' => is_writable(__DIR__),
  'data/ folder is writable' => is_writable(__DIR__ . '/data'),
  'HTTPS (needed for the phone camera)' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'),
];
$done = null;

if (!$installed && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
  $host = trim($_POST['host'] ?? 'localhost');
  $name = trim($_POST['name'] ?? '');
  $user = trim($_POST['user'] ?? '');
  $pass = (string) ($_POST['pass'] ?? '');
  if (!$name || !$user) $errors[] = 'Enter the database name and user.';
  if (!$errors) {
    try {
      $dsn = "mysql:host=$host;dbname=$name;charset=utf8mb4";
      $pdo = new PDO($dsn, $user, $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
      foreach (ss_schema('mysql') as $sql) $pdo->exec($sql);
      $setupKey = implode('-', str_split(strtoupper(bin2hex(random_bytes(8))), 4));
      $cfg = "<?php\n// SmartScan portal configuration (created " . date('Y-m-d H:i') . "). Keep private.\nreturn " . var_export([
        'dsn' => $dsn, 'db_user' => $user, 'db_pass' => $pass,
        'setup_key_hash' => hash('sha256', $setupKey),
        'data_dir' => __DIR__ . '/data', 'max_blob_mb' => 60, 'blob_ttl_days' => 7,
      ], true) . ";\n";
      if (file_put_contents($configFile, $cfg) === false) throw new Exception('Could not write config.php — check folder permissions.');
      @chmod($configFile, 0640);
      $done = $setupKey;
    } catch (Throwable $e) {
      $errors[] = 'Database connection failed: ' . htmlspecialchars($e->getMessage());
    }
  }
}
$base = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'your-domain') . rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/');
?><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SmartScan portal setup</title>
<style>
body{font:15px/1.5 system-ui,Segoe UI,sans-serif;background:#f4f6fb;color:#0f172a;margin:0;padding:30px 16px}
.card{max-width:560px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,.08);padding:28px}
h1{margin:0 0 6px;font-size:24px}label{display:block;font-weight:600;margin:14px 0 4px}input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:10px;background:#2563eb;color:#fff;font-weight:600;font-size:16px;cursor:pointer}
.ok{color:#16a34a}.bad{color:#dc2626}.err{background:#fde8e8;color:#b91c1c;padding:10px 12px;border-radius:8px;margin-top:12px}
.key{font:700 26px/1.2 ui-monospace,Consolas,monospace;letter-spacing:2px;background:#eff6ff;color:#1d4ed8;padding:16px;border-radius:12px;text-align:center;margin:14px 0;user-select:all}
.muted{color:#64748b;font-size:13px}code{background:#f1f5f9;padding:2px 6px;border-radius:5px}
</style></head><body><div class="card">
<h1>SmartScan portal</h1>
<?php if ($done): ?>
  <p class="ok"><b>Installed successfully.</b></p>
  <p>Your <b>office setup key</b> (shown only once — write it down):</p>
  <div class="key"><?= htmlspecialchars($done) ?></div>
  <p>On each office PC open SmartScan → <b>Phone &amp; Web</b> and enter:</p>
  <p>Portal address: <code><?= htmlspecialchars($base) ?></code><br>Setup key: the key above</p>
  <p class="muted">For safety, delete <code>install.php</code> from your hosting now (File Manager). The phone app is at <code><?= htmlspecialchars($base) ?>/app/</code> — but phones are connected by scanning the QR code shown on the PC.</p>
<?php elseif ($installed): ?>
  <p>The portal is already installed. To reinstall, delete <code>config.php</code> first.</p>
  <p class="muted">Delete <code>install.php</code> from your hosting if you have not done so.</p>
<?php else: ?>
  <p class="muted">Create a MySQL database and user in cPanel/hPanel (“MySQL Databases”), give the user ALL privileges on the database, then enter the details below.</p>
  <ul>
  <?php foreach ($checks as $k => $v): ?><li class="<?= $v ? 'ok' : 'bad' ?>"><?= $v ? '✔' : '✖' ?> <?= htmlspecialchars($k) ?></li><?php endforeach; ?>
  </ul>
  <?php foreach ($errors as $e): ?><div class="err"><?= $e ?></div><?php endforeach; ?>
  <form method="post" autocomplete="off">
    <label>Database host</label><input name="host" value="<?= htmlspecialchars($_POST['host'] ?? 'localhost') ?>">
    <label>Database name</label><input name="name" value="<?= htmlspecialchars($_POST['name'] ?? '') ?>" placeholder="e.g. cpuser_smartscan">
    <label>Database user</label><input name="user" value="<?= htmlspecialchars($_POST['user'] ?? '') ?>" placeholder="e.g. cpuser_ssuser">
    <label>Database password</label><input name="pass" type="password">
    <button type="submit">Install portal</button>
  </form>
<?php endif; ?>
</div></body></html>
