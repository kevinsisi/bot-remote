# Start bot-remote hidden in the background; stops any old instance first. ASCII only (PS 5.1 compatible).
$root = $PSScriptRoot
& "$root\stop.ps1"
Start-Process -WindowStyle Hidden -WorkingDirectory $root `
    -FilePath "node" -ArgumentList "`"$root\src\index.js`"" `
    -RedirectStandardOutput "$root\bot.log" -RedirectStandardError "$root\bot.err.log"
Write-Output "bot-remote started in background, log: $root\bot.log"
