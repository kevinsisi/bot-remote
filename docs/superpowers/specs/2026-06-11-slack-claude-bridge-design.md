# bot-remote: Slack → Claude Code Bridge — Design

Date: 2026-06-11
Status: Approved (brainstorm 完成,使用者選方案 A)

## 目標

人在外面用手機 Slack 下指令,公司電腦上的 Claude Code 執行並把結果貼回 Slack。

## 已確認的決策

- **Slack workspace**:使用者自建的免費 workspace(非公司 Slack),自建 App 無審核問題。
- **連線方式**:Slack **Socket Mode**(公司電腦 outbound WebSocket 連 Slack 雲端),不需開 inbound port、不需 public IP、不動公司防火牆。
- **權限**:`--dangerously-skip-permissions` 全自動執行;風險控制靠(1)只回應白名單 Slack user ID、(2)工作目錄由使用者指令控制。
- **使用型態**:單一 channel = 一個延續對話(`--resume <session-id>`),控制指令可切專案目錄、重開 session。
- **獨立專案**:與 claudecode-remote 解耦,壞了互不影響。

## 架構

```
手機 Slack App → Slack 雲端 ←(Socket Mode WS, outbound)← bot-remote daemon (公司電腦)
                                                              ↓ spawn
                                claude -p --resume <sid> --dangerously-skip-permissions
                                       --output-format stream-json --verbose
```

## 元件

| 檔案 | 職責 |
|---|---|
| `src/index.js` | Bolt App(Socket Mode)入口、訊息路由、白名單過濾 |
| `src/claude-runner.js` | spawn Claude CLI、NDJSON 解析、FIFO 佇列(一次一個)、timeout、kill |
| `src/commands.js` | 解析 `!` 控制指令(純函式) |
| `src/slack-format.js` | Markdown→mrkdwn 簡轉換、4000 字切塊(純函式) |
| `src/state.js` | `data/state.json` 持久化(sessionId、cwd),重啟存活 |
| `src/config.js` | `.env` 載入與驗證 |

## 訊息流

1. channel 收到訊息 → 非白名單 user / bot 訊息 → 忽略。
2. `!` 開頭 → 控制指令:`!help`、`!new`(重開 session)、`!cwd <path>`(切專案,驗證存在)、`!status`、`!stop`(kill 目前執行)。
3. 一般訊息 → 排入佇列;執行中則回「已排隊 #n」。
4. 執行時先貼 placeholder「⏳ 執行中…」,每 ≥3 秒 `chat.update` 進度(經過時間+最新 assistant 片段)。
5. `result` 事件 → 最終結果切塊(≤3900 字/則)貼回;超長(>12000 字)改上傳文字檔。
6. stream-json `init` 事件的 `session_id` 持久化,下次 `--resume`。

## 錯誤處理

- Claude process 非零退出 / `is_error` → 把 stderr/錯誤原文貼回 Slack,不吞錯、不假裝成功。
- 單一任務 timeout(預設 30 分)→ taskkill process tree、回報。
- Slack 斷線由 Bolt 內建重連。
- prompt 經 stdin 餵入,避免 shell quoting 問題。

## 安全

- 只回應 `ALLOWED_USER_IDS`(逗號分隔)中的 user。
- 可選 `CHANNEL_ID` 限制只聽特定 channel。
- token 放 `.env`(gitignored)。

## 測試

- `node --test`:`slack-format`(切塊邊界、mrkdwn 轉換)、`commands`(指令解析)純函式單元測試。
- 端對端需真實 Slack token,由使用者建好 App 後實機驗證。

## Agent 派工(2026-06-13 改版:背景任務池)

- 主對話 = orchestrator,預設模型 `claude-fable-5`(`!model` 可改,存 state.json)。
- ~~原生 Task 工具派工~~ 改為**背景任務池**:原生 Task 是同步的,master 會卡整輪等 worker,
  導致使用者的下一則訊息排隊。改成 claudecode-remote task-manager 的輕量版:
  - `src/dispatch-server.js`:本機 HTTP 端點(127.0.0.1:`DISPATCH_PORT`,預設 8765),
    `POST /tasks {prompt, description}` 派工、`GET /tasks` 查狀態。
  - `src/task-pool.js`:每任務獨立 `claude -p`(模型 `WORKER_MODEL`,預設 claude-sonnet-4-6),
    平行上限 10,完成 emit done。
  - master 系統提示:粗重工作用 curl 派背景任務後「立刻回覆、絕不等待」;prompt 必須自包含。
  - 完成時 bot 自動貼結果到最後互動的 channel(存 state.lastChannel,重啟存活),
    ≥60s 的任務另發 mention 訊息觸發推播。
- claude 是原生 exe,spawn 不走 cmd shell。

## 常駐機制(2026-06-11 增補)

- 排程工作 `bot-remote-watchdog`:登入觸發 + 每 2 分鐘,跑 `wscript.exe watchdog.vbs` → `watchdog.ps1`(完全無視窗)。
- bot 必須由排程器啟動:Claude Code 工具沙箱會殺掉所有子孫程序。
- `.ps1` 必須純 ASCII:排程器用 Windows PowerShell 5.1,UTF-8 無 BOM 中文會被 ANSI 誤讀。

## 不做(YAGNI)

- 圖片上傳、多 session/thread、task pool、Web UI(claudecode-remote 已有)。
