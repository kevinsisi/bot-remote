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

## 不做(YAGNI)

- 圖片上傳、多 session/thread、task pool、Web UI(claudecode-remote 已有)。
