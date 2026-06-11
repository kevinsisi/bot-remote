# 停止 bot-remote(找出跑 src/index.js 的 node process)
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'bot-remote' -and $_.CommandLine -match 'src[\\/]index\.js' }
if ($procs) {
    $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
    Write-Host "已停止 $($procs.Count) 個 bot-remote process"
} else {
    Write-Host "沒有執行中的 bot-remote"
}
