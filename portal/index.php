<?php
// Entry point: send visitors to the phone app (or to the installer on first run).
if (!file_exists(__DIR__ . '/config.php')) { header('Location: install.php'); exit; }
header('Location: app/');
