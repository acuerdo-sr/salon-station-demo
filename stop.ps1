$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No recorded background server. For npm start, use Ctrl+C in its terminal.'; exit }
$serverProcessId = [int](Get-Content -LiteralPath $pidFile)
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $serverProcessId"
$expectedScript = Join-Path $PSScriptRoot 'server.mjs'
if ($serverProcess -and $serverProcess.Name -eq 'node.exe' -and $serverProcess.CommandLine.Contains($expectedScript)) {
    Stop-Process -Id $serverProcessId
    Remove-Item -LiteralPath $pidFile
    Write-Output 'SALON STATION stopped. Saved orders and stock were kept.'
} elseif ($serverProcess) {
    throw 'The recorded process is not this demo server. No process was stopped.'
} else {
    Remove-Item -LiteralPath $pidFile
    Write-Output 'The recorded server is already stopped.'
}
