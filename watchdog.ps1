# bot-remote watchdog: restart the bot if it is not running. ASCII only (runs under Windows PowerShell 5.1 via Task Scheduler).
$root = $PSScriptRoot
$alive = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'bot-remote' -and $_.CommandLine -match 'src[\\/]index\.js' }
if ($alive) { exit 0 }

"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') bot not running, restarting" | Add-Content "$root\watchdog.log"
& "$root\start-hidden.ps1"
