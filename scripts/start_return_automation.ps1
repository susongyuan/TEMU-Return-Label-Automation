param(
    [string]$ModuleDir = ""
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($ModuleDir)) {
    $ModuleDir = Split-Path -Parent $ScriptDir
}

Set-Location $ModuleDir

if (-not (Test-Path -LiteralPath (Join-Path $ModuleDir "node_modules"))) {
    npm install
}

npm start
