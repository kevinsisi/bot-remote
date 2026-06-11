# 背景無視窗啟動 bot-remote;重複執行會先停掉舊的
$root = $PSScriptRoot
& "$root\stop.ps1"
Start-Process -WindowStyle Hidden -WorkingDirectory $root `
    -FilePath "node" -ArgumentList "src/index.js" `
    -RedirectStandardOutput "$root\bot.log" -RedirectStandardError "$root\bot.err.log"
Write-Host "bot-remote 已在背景啟動,log: $root\bot.log"
