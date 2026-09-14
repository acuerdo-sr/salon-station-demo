$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js 22.13 or later is required. Install Node.js and run this script again.' }
try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4173/api/products' -TimeoutSec 2
    $items = $response.Content | ConvertFrom-Json
    if ($items[0].id -eq 'shampoo-moist') { Start-Process 'http://127.0.0.1:4173/'; exit }
} catch {}
$serverPath = Join-Path $PSScriptRoot 'server.mjs'
$serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList ('"' + $serverPath + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'server-error.log')
$serverProcess.Id | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'server.pid')
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 200
    try { $response = Invoke-WebRequest -Uri 'http://127.0.0.1:4173/api/products' -TimeoutSec 1; if ($response.StatusCode -eq 200) { Start-Process 'http://127.0.0.1:4173/'; exit } } catch {}
    if ($serverProcess.HasExited) { throw 'Server failed to start. See server-error.log.' }
}
throw 'Server startup timed out. See server-error.log.'
