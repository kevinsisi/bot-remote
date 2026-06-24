import 'dotenv/config';

const DEFAULT_PROGRESS_INTERVAL_MS = 3000;
// 任務跑超過這個秒數,完成時 @使用者 觸發手機推播;太快完成的不吵
const DEFAULT_MENTION_MIN_SECONDS = 60;

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`缺少必要環境變數 ${name},請參考 .env.example 設定 .env`);
    process.exit(1);
  }
  return value;
}

export const config = {
  slackBotToken: required('SLACK_BOT_TOKEN'),
  slackAppToken: required('SLACK_APP_TOKEN'),
  allowedUserIds: required('ALLOWED_USER_IDS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // 留空 = 聽所有 bot 所在的 channel
  channelId: process.env.CHANNEL_ID || null,
  claudeCmd: process.env.CLAUDE_CMD || 'claude',
  // 主對話(orchestrator)預設模型;可由 state.model / !model 覆寫
  masterModel: process.env.MASTER_MODEL || 'claude-opus-4-8',
  // 派工 agent 用的模型(主對話模型由 state.model / !model 控制)
  workerModel: process.env.WORKER_MODEL || 'claude-sonnet-4-6',
  defaultCwd: process.env.DEFAULT_CWD || process.cwd(),
  // 0 = 不限時(預設);要設上限才填 TASK_TIMEOUT_MS,手動中斷用 !stop
  taskTimeoutMs: Number(process.env.TASK_TIMEOUT_MS) || 0,
  progressIntervalMs:
    Number(process.env.PROGRESS_INTERVAL_MS) || DEFAULT_PROGRESS_INTERVAL_MS,
  mentionMinSeconds:
    Number(process.env.MENTION_MIN_SECONDS) || DEFAULT_MENTION_MIN_SECONDS,
  // 本機派工端點(只綁 127.0.0.1),master 用 curl 丟背景任務
  dispatchPort: Number(process.env.DISPATCH_PORT) || 8765,
  // 每日心跳通知(預設開);設 HEARTBEAT_ENABLED=false 關閉
  heartbeatEnabled: (process.env.HEARTBEAT_ENABLED || 'true').toLowerCase() !== 'false',
};
