'use strict';
/**
 * USB/network scanner support on Windows through WIA 2.0 (Windows Image
 * Acquisition), driven by the built-in PowerShell + WIA COM automation
 * library. Works with any scanner that ships a WIA driver (most do).
 */
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AppError } = require('./storage');

const isWin = process.platform === 'win32';

function runPS(script, env = {}, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      env: { ...process.env, ...env }, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').toString();
        return reject(new AppError(friendly(msg)));
      }
      resolve(stdout.toString());
    });
  });
}

function friendly(msg) {
  if (/80210003|paper empty|no documents/i.test(msg)) return 'The scanner feeder is empty. Load paper and try again.';
  if (/80210015|80210005|offline|not connected|busy/i.test(msg)) return 'The scanner is busy or offline. Check the cable/power and try again.';
  if (/80210064|cancel/i.test(msg)) return 'Scan cancelled.';
  if (/No scanner/i.test(msg)) return 'No scanner was found. Connect a scanner with a WIA driver and try again.';
  return `Scanner error: ${msg.split(/\r?\n/).find((l) => l.trim()) || 'unknown error'}`;
}

const LIST_PS = `
$ErrorActionPreference = 'Stop'
$dm = New-Object -ComObject WIA.DeviceManager
$out = @()
foreach ($d in $dm.DeviceInfos) {
  if ($d.Type -eq 1) {
    $name = $null; try { $name = $d.Properties.Item('Name').Value } catch {}
    $out += [pscustomobject]@{ id = $d.DeviceID; name = $name }
  }
}
ConvertTo-Json -InputObject @($out) -Compress
`;

const ACQUIRE_PS = `
$ErrorActionPreference = 'Stop'
$fmtJpeg = '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}'
$fmtPng  = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'
$fmtBmp  = '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}'
$outDir = $env:SS_OUT
$dpi = [int]$env:SS_DPI
$intent = [int]$env:SS_INTENT
$useDialog = $env:SS_DIALOG -eq '1'
$feeder = $env:SS_FEEDER -eq '1'
function SetProp($props, $id, $val) { foreach ($p in $props) { if ($p.PropertyID -eq $id) { try { $p.Value = $val } catch {} } } }
function Save($img, $i) {
  $ext = 'jpg'
  if ($img.FormatID -eq $fmtPng) { $ext = 'png' } elseif ($img.FormatID -eq $fmtBmp) { $ext = 'bmp' }
  $f = Join-Path $outDir ("scan_{0:D3}.{1}" -f $i, $ext)
  if (Test-Path $f) { Remove-Item $f }
  $img.SaveFile($f)
  Write-Output $f
}
if ($useDialog) {
  $cd = New-Object -ComObject WIA.CommonDialog
  $img = $cd.ShowAcquireImage(1, $intent, 0, $fmtJpeg, $false, $true, $false)
  if ($img -eq $null) { throw 'Scan cancelled' }
  Save $img 1
  exit 0
}
$dm = New-Object -ComObject WIA.DeviceManager
$info = $null
foreach ($d in $dm.DeviceInfos) { if ($d.Type -eq 1 -and ($env:SS_DEVICE -eq '' -or $d.DeviceID -eq $env:SS_DEVICE)) { $info = $d; break } }
if ($info -eq $null) { throw 'No scanner found' }
$dev = $info.Connect()
if ($feeder) { SetProp $dev.Properties 3088 1 } else { SetProp $dev.Properties 3088 2 }
$item = $dev.Items.Item(1)
SetProp $item.Properties 6146 $intent
SetProp $item.Properties 6147 $dpi
SetProp $item.Properties 6148 $dpi
$i = 0
while ($true) {
  $i++
  $img = $null
  foreach ($fmt in @($fmtJpeg, $fmtPng, $fmtBmp)) {
    try { $img = $item.Transfer($fmt); break } catch {
      if ($_.Exception.HResult -eq -2145320957 -and $i -gt 1) { exit 0 }  # feeder empty after >=1 page
      if ($fmt -eq $fmtBmp) { throw }
    }
  }
  Save $img $i
  if (-not $feeder -or $i -ge 200) { break }
}
`;

async function listScanners() {
  if (!isWin) return { supported: false, devices: [], message: 'Scanner (WIA) support is available on Windows.' };
  const out = await runPS(LIST_PS, {}, 30000);
  let devices = [];
  try { devices = JSON.parse(out.trim() || '[]'); } catch { devices = []; }
  if (!Array.isArray(devices)) devices = [devices];
  return { supported: true, devices: devices.filter(Boolean).map((d) => ({ id: d.id, name: d.name || 'Scanner' })) };
}

/** Returns an array of { name, bytes } images. */
async function acquire({ deviceId = '', dpi = 300, color = 'color', feeder = false, dialog = false } = {}) {
  if (!isWin) throw new AppError('Scanner (WIA) support is available on Windows. Use the camera or import images instead.');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartscan-wia-'));
  const intent = { color: 1, gray: 2, bw: 4 }[color] || 1;
  try {
    const out = await runPS(ACQUIRE_PS, {
      SS_OUT: outDir, SS_DPI: String(Math.min(1200, Math.max(75, Number(dpi) || 300))), SS_INTENT: String(intent),
      SS_FEEDER: feeder ? '1' : '0', SS_DIALOG: dialog ? '1' : '0', SS_DEVICE: String(deviceId || '').replace(/[^\w{}\\&#.-]/g, ''),
    }, feeder ? 900000 : 240000);
    const files = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && fs.existsSync(s) && path.dirname(s) === outDir);
    if (!files.length) throw new AppError('The scanner did not return an image.');
    return files.map((f) => ({ name: path.basename(f), bytes: fs.readFileSync(f), id: crypto.randomUUID() }));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

module.exports = { listScanners, acquire };
