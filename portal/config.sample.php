<?php
// Created automatically by install.php. Keep this file private.
return [
  'dsn' => 'mysql:host=localhost;dbname=YOUR_DB;charset=utf8mb4',
  'db_user' => 'YOUR_DB_USER',
  'db_pass' => 'YOUR_DB_PASSWORD',
  'setup_key_hash' => '',          // sha256 of the office setup key
  'data_dir' => __DIR__ . '/data', // encrypted blobs are stored here
  'max_blob_mb' => 60,
  'blob_ttl_days' => 7,
];
