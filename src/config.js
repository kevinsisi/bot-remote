import 'dotenv/config';

const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_PROGRESS_INTERVAL_MS = 3000;

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
  // 派工 agent 用的模型(主對話模型由 state.model / !model 控制)
  workerModel: process.env.WORKER_MODEL || 'claude-sonnet-4-6',
  defaultCwd: process.env.DEFAULT_CWD || process.cwd(),
  taskTimeoutMs: Number(process.env.TASK_TIMEOUT_MS) || DEFAULT_TASK_TIMEOUT_MS,
  progressIntervalMs:
    Number(process.env.PROGRESS_INTERVAL_MS) || DEFAULT_PROGRESS_INTERVAL_MS,
};
