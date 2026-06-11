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

開機自動啟動(背景無視窗):

```powershell
.\start-hidden.ps1   # 手動背景啟動
.\stop.ps1           # 停止
```

要開機自動跑,把 `start-hidden.ps1` 加進工作排程器(登入時觸發)即可。

## 三、使用

在 channel 直接打字就是對 Claude 下指令(同一個延續對話):

| 指令 | 作用 |
|---|---|
| `!cwd <path>` | 切換工作目錄(並重開 session) |
| `!new` | 重開全新 session |
| `!status` | 顯示目錄 / session / 佇列狀態 |
| `!stop` | 中斷目前任務 |
| `!help` | 指令說明 |

## 安全注意

- Claude 以 `--dangerously-skip-permissions` 全自動執行,**只回應 `ALLOWED_USER_IDS` 白名單**,其他人(包含其他 bot)一律忽略。
- token 放 `.env`,已 gitignore;workspace 是你私人的,不經過公司 Slack。
- 一次只執行一個任務,其餘 FIFO 排隊;單一任務逾時 30 分鐘自動終止。

## 開發

```powershell
npm test        # 單元測試(node --test)
npm run check   # 語法檢查
```
