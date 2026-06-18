# bot-remote

用手機 Slack 遠端操作公司電腦上的 Claude Code。

```
手機 Slack App → Slack 雲端 ←(Socket Mode, outbound WebSocket)← 公司電腦 bot-remote
                                                                       ↓
                                                              claude -p(headless)
```

公司電腦只需要能連外網,**不用開 inbound port、不用 public IP、不動防火牆**。

## 一、建 Slack App(一次性,約 5 分鐘)

1. 自己開一個免費 Slack workspace(手機 Slack App 登入同一個 workspace)。
2. 到 <https://api.slack.com/apps> → **Create New App** → **From a manifest** → 選你的 workspace,貼上:

```yaml
display_information:
  name: claude-bridge
features:
  bot_user:
    display_name: claude-bridge
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:history
      - groups:history
      - files:write
settings:
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
  socket_mode_enabled: true
```

3. **Basic Information → App-Level Tokens** → Generate Token,scope 選 `connections:write` → 得到 `xapp-...`(填 `SLACK_APP_TOKEN`)。
4. **OAuth & Permissions → Install to Workspace** → 得到 `xoxb-...`(填 `SLACK_BOT_TOKEN`)。
5. 開一個 channel(例如 `#claude`),在 channel 裡 `/invite @claude-bridge`。
6. Slack 個人檔案 → ⋮ → 複製成員 ID → 填 `ALLOWED_USER_IDS`。

## 二、公司電腦設定

```powershell
cd D:\Projects\_HomeProject\bot-remote
npm install
copy .env.example .env   # 填入上面拿到的 token
npm start
```

常駐 + 開機自啟(watchdog,建議做法)——註冊一個工作排程器任務,登入時觸發 + 每 2 分鐘檢查,bot 掛了自動拉起。透過 `wscript.exe` + `watchdog.vbs` 執行,完全不會閃出視窗:

```powershell
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"D:\Projects\_HomeProject\bot-remote\watchdog.vbs"'
$logon  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName 'bot-remote-watchdog' -Action $action -Trigger $logon, $repeat -Settings $settings -Force
```

手動操作:

```powershell
.\start-hidden.ps1   # 手動背景啟動(會先停舊的)
.\stop.ps1           # 停止
```

注意:`*.ps1` 腳本必須保持純 ASCII 內容——排程器用 Windows PowerShell 5.1 執行,UTF-8(無 BOM)中文會被 ANSI 誤讀導致腳本壞掉。重啟紀錄在 `watchdog.log`。

## 三、使用

在 channel 直接打字就是對 Claude 下指令(同一個延續對話):

| 指令 | 作用 |
|---|---|
| `!cwd <path>` | 切換工作目錄(並重開 session) |
| `!new` | 重開全新 session |
| `!status` | 顯示目錄 / session / 佇列狀態 |
| `!stop` | 中斷目前任務 |
| `!help` | 指令說明 |

## Agent 派工(背景任務池)

主對話是 orchestrator(預設 `claude-opus-4-8`,`MASTER_MODEL` 可覆寫),收到粗重工作時會透過本機 HTTP 端點(`127.0.0.1:8765`,僅本機)丟進**背景任務池**後立刻回覆你——不會卡住對話,你可以馬上下下一個指令。worker(預設 `claude-sonnet-4-6`,`WORKER_MODEL` 可覆寫)在背景平行跑(上限 10 個),做完時 bot 自動把結果貼回 channel(超過 60 秒的會 @你 推播)。`!status` 可看背景任務清單;問 master「任務跑得怎樣」它會查進度回報。

## 安全注意

- Claude 以 `--dangerously-skip-permissions` 全自動執行,**只回應 `ALLOWED_USER_IDS` 白名單**,其他人(包含其他 bot)一律忽略。
- token 放 `.env`,已 gitignore;workspace 是你私人的,不經過公司 Slack。
- 一次只執行一個任務,其餘 FIFO 排隊;單一任務逾時 30 分鐘自動終止。

## 開發

```powershell
npm test        # 單元測試(node --test)
npm run check   # 語法檢查
```
