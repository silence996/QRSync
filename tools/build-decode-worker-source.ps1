# Regenerates receiver/decode-worker-source.js for file:// Blob Worker.
# Run: powershell -File tools/build-decode-worker-source.ps1

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')

$jsqrPath = Join-Path $root 'js\jsQR.js'
$zxingPath = Join-Path $root 'js\zxing-wasm-reader.js'
$workerPath = Join-Path $root 'receiver\decode-worker.js'
$outPath = Join-Path $root 'receiver\decode-worker-source.js'

$jsqr = [System.IO.File]::ReadAllText($jsqrPath)
$zxing = [System.IO.File]::ReadAllText($zxingPath)
$worker = [System.IO.File]::ReadAllText($workerPath)
$worker = [regex]::Replace($worker, '(?m)^\s*importScripts\s*\([^)]*\)\s*;?\s*$', '/* inlined */')
$combined = $jsqr + "`n;`n" + $zxing + "`n;`n" + $worker
$escaped = ($combined | ConvertTo-Json -Compress)
$header = "/* auto-generated — run: powershell -File tools/build-decode-worker-source.ps1 */`n"
[System.IO.File]::WriteAllText($outPath, $header + "window.__QRSyncDecodeWorkerSource = $escaped;`n")
Write-Host "Wrote $outPath ($((Get-Item $outPath).Length) bytes)"
