$ErrorActionPreference = "Stop"
$env:CODEX_TASKBOARD_HOST = "127.0.0.1"

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
Write-Host "正在启动 Taskboard 服务并挂载 Codex 菜单..."
$logPath = Join-Path ([System.IO.Path]::GetTempPath()) "codex-taskboard-launch.log"
& npm.cmd run codex *>&1 | Tee-Object -FilePath $logPath
exit $LASTEXITCODE
