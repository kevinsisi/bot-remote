# Stop bot-remote (node process running bot-remote src/index.js). ASCII only (PS 5.1 compatible).
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'bot-remote' -and $_.CommandLine -match 'src[\\/]index\.js' }
if ($procs) {
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
    Write-Output "stopped $(@($procs).Count) bot-remote process(es)"
} else {
    Write-Output "no running bot-remote"
}
