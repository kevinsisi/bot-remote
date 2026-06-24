import pkg from '@slack/bolt';
import { existsSync, statSync } from 'node:fs';
import { config } from './config.js';
import { loadState, saveState } from './state.js';
import {
  parseCommand,
  HELP_TEXT,
  MODEL_LIST_TEXT,
  isValidModel,
} from './commands.js';
import {
  toMrkdwn,
  chunkText,
  FILE_UPLOAD_THRESHOLD,
} from './slack-format.js';
import { ClaudeRunner } from './claude-runner.js';
import { TaskPool } from './task-pool.js';
import { startDispatchServer } from './dispatch-server.js';
import { runAuthPreflight, isAuthError } from './auth-check.js';

const { App } = pkg;

const state = loadState({ sessionId: null, cwd: config.defaultCwd, model: config.masterModel });
const runner = new ClaudeRunner({
  claudeCmd: config.claudeCmd,
  taskTimeoutMs: config.taskTimeoutMs,
  workerModel: config.workerModel,
  dispatchPort: config.dispatchPort,
});

// 背景任務池:master 透過本機 HTTP 派工,完成時自動回報 Slack
const pool = new TaskPool({
  claudeCmd: config.claudeCmd,
  workerModel: config.workerModel,
});
// 回報目的地:最後互動的 channel/使用者(存進 state,重啟後仍可回報)
if (!state.lastChannel) state.lastChannel = config.channelId;
if (!state.lastUser) state.lastUser = config.allowedUserIds[0];
// 背景任務的進度訊息:id -> { ts, lastUpdate, lastText, lastThinking }
const taskProgress = new Map();

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
  // Client sends a WebSocket ping to Slack every 20s.
  // This keeps corporate NAT entries alive so the connection never goes zombie.
  // serverPingTimeout: Slack must ping us within 30s or we reconnect (SDK default).
  clientPingTimeout: 20_000,
});

app.message(async ({ message, client }) => {
  // 只處理一般文字訊息(排除 bot、編輯、加入頻道等 subtype)
  if (message.subtype || message.bot_id) return;
  if (config.channelId && message.channel !== config.channelId) return;
  if (!config.allowedUserIds.includes(message.user)) return;

  const text = (message.text || '').trim();
  if (!text) return;

  const channel = message.channel;
  if (state.lastChannel !== channel || state.lastUser !== message.user) {
    state.lastChannel = channel;
    state.lastUser = message.user;
    saveState(state);
  }
  const command = parseCommand(text);
  if (command) {
    await handleCommand(command, channel, client);
    return;
  }

  const placeholder = await client.chat.postMessage({
    channel,
    text: runner.isRunning ? '🕐 已排隊…' : '⏳ 執行中…',
  });
  runner.enqueue(buildTask(text, channel, client, placeholder.ts, message.user));
});

const PROGRESS_SNIPPET_LIMIT = 500;

function truncateForProgress(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PROGRESS_SNIPPET_LIMIT
    ? `…${flat.slice(-PROGRESS_SNIPPET_LIMIT)}`
    : flat;
}

function buildTask(prompt, channel, client, placeholderTs, userId) {
  let lastUpdate = 0;
  let lastThinking = '';
  let lastText = '';
  const startedAt = Date.now();

  return {
    prompt,
    // getter:開跑當下才讀,排隊期間 !cwd/!new 或前一個任務寫入的 session 才會生效
    get cwd() {
      return state.cwd;
    },
    get sessionId() {
      return state.sessionId;
    },
    get model() {
      return state.model;
    },

    onProgress: ({ text, thinking }) => {
      if (thinking) lastThinking = thinking;
      if (text) lastText = text;
      const now = Date.now();
      if (now - lastUpdate < config.progressIntervalMs) return;
      lastUpdate = now;
      const elapsed = Math.round((now - startedAt) / 1000);
      const parts = [`⏳ 執行中(${elapsed}s)…`];
      if (lastThinking) parts.push(`💭 _${truncateForProgress(lastThinking)}_`);
      if (lastText) parts.push(toMrkdwn(truncateForProgress(lastText)));
      client.chat
        .update({ channel, ts: placeholderTs, text: parts.join('\n') })
        .catch(() => {}); // 進度更新失敗不影響任務
    },

    onDone: async (result) => {
      if (result.sessionId && result.sessionId !== state.sessionId) {
        state.sessionId = result.sessionId;
        saveState(state);
      }
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const authDead = !result.ok && isAuthError(result.text);
      const header = result.ok
        ? `✅ 完成(${elapsed}s)`
        : authDead
          ? `🔑 認證失效(${elapsed}s)`
          : `❌ 失敗(${elapsed}s)`;
      try {
        await client.chat.update({ channel, ts: placeholderTs, text: header });
        if (authDead) {
          await client.chat.postMessage({
            channel,
            text:
              '🔑 *認證失效* — 請在公司電腦執行 `claude setup-token`,把 token 設進 `.env` 的 `CLAUDE_CODE_OAUTH_TOKEN` 後重啟 bot。',
          });
          return;
        }
        await postLongText(client, channel, result.text || '(沒有輸出)');
        // 長任務結束時另發一則帶 mention 的新訊息觸發手機推播
        //(編輯舊訊息加 mention 不會推播);秒回的任務不吵
        if (elapsed >= config.mentionMinSeconds) {
          await client.chat.postMessage({
            channel,
            text: `<@${userId}> 🔔 任務${result.ok ? '完成' : '失敗'}(${elapsed}s),結果在上方`,
          });
        }
      } catch (err) {
        console.error('回貼 Slack 失敗:', err);
      }
    },
  };
}

async function postLongText(client, channel, raw, threadTs) {
  if (raw.length > FILE_UPLOAD_THRESHOLD) {
    await client.filesUploadV2({
      channel_id: channel,
      filename: 'claude-output.md',
      content: raw,
      initial_comment: '輸出過長,改附檔案:',
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    return;
  }
  for (const chunk of chunkText(toMrkdwn(raw))) {
    await client.chat.postMessage({ channel, text: chunk, ...(threadTs ? { thread_ts: threadTs } : {}) });
  }
}

async function handleCommand(command, channel, client) {
  const say = (text) => client.chat.postMessage({ channel, text });

  switch (command.type) {
    case 'help':
      await say(HELP_TEXT);
      break;
    case 'new':
      state.sessionId = null;
      saveState(state);
      await say('🆕 已重開新 session,下一則訊息會是全新對話');
      break;
    case 'cwd': {
      if (!command.path) {
        await say(`目前工作目錄:\`${state.cwd}\``);
        break;
      }
      if (!existsSync(command.path) || !statSync(command.path).isDirectory()) {
        await say(`❌ 目錄不存在:\`${command.path}\``);
        break;
      }
      state.cwd = command.path;
      state.sessionId = null; // 換專案 = 換對話脈絡,重開 session
      saveState(state);
      await say(`📁 已切換到 \`${command.path}\`(session 已重開)`);
      break;
    }
    case 'status':
      await say(
        [
          `📁 工作目錄:\`${state.cwd}\``,
          `🧵 session:\`${state.sessionId || '(新)'}\``,
          `🤖 模型:\`${state.model || '(預設)'}\``,
          `⚙️ 執行中:${runner.isRunning ? '是' : '否'},佇列:${runner.queueLength}`,
          `🛠️ 背景任務:${pool.running.length} 個執行中` +
            (pool.list().length
              ? '\n' +
                pool
                  .list()
                  .slice(-10)
                  .map((t) => `  #${t.id} [${t.status}] ${t.description}(${t.elapsedSec}s)`)
                  .join('\n')
              : ''),
        ].join('\n')
      );
      break;
    case 'model': {
      if (!command.model) {
        await say(`🤖 目前模型:\`${state.model || '(預設)'}\`\n${MODEL_LIST_TEXT}`);
        break;
      }
      if (!isValidModel(command.model)) {
        await say(`❌ 不認識的模型 \`${command.model}\`\n${MODEL_LIST_TEXT}`);
        break;
      }
      state.model = command.model.toLowerCase() === 'default' ? null : command.model.toLowerCase();
      saveState(state);
      await say(`🤖 已切換模型:\`${state.model || '(預設)'}\`(下一則訊息生效)`);
      break;
    }
    case 'stop':
      if (command.target) {
        const ok = pool.stop(command.target);
        await say(ok ? `🛑 已停止背景任務 #${command.target}` : `找不到執行中的背景任務 #${command.target}`);
      } else {
        await say(runner.stop() ? '🛑 已送出中斷(主任務)' : '目前沒有執行中的主任務');
      }
      break;
    default:
      await say(`不認識的指令 \`${command.name}\`,輸入 \`!help\` 看用法`);
  }
}

// 任務開跑:貼一則進度 placeholder,之後 progress 事件會就地更新它
pool.on('start', async (task) => {
  const channel = state.lastChannel;
  if (!channel) return;
  try {
    const msg = await app.client.chat.postMessage({
      channel,
      text: `🛠️ 背景任務 #${task.id}「${task.description}」開始…`,
    });
    taskProgress.set(task.id, { ts: msg.ts, lastUpdate: 0, lastText: '', lastThinking: '' });
  } catch (err) {
    console.error(`貼 task #${task.id} 開始訊息失敗:`, err);
  }
});

// 任務進度:節流更新 placeholder(顯示 thinking + 最新片段)
pool.on('progress', ({ task, text, thinking }) => {
  const p = taskProgress.get(task.id);
  if (!p || !state.lastChannel) return;
  if (thinking) p.lastThinking = thinking;
  if (text) p.lastText = text;
  const now = Date.now();
  if (now - p.lastUpdate < config.progressIntervalMs) return;
  p.lastUpdate = now;
  const elapsed = Math.round((now - task.startedAt) / 1000);
  const parts = [`🛠️ #${task.id}「${task.description}」執行中(${elapsed}s)…`];
  if (p.lastThinking) parts.push(`💭 _${truncateForProgress(p.lastThinking)}_`);
  if (p.lastText) parts.push(toMrkdwn(truncateForProgress(p.lastText)));
  app.client.chat
    .update({ channel: state.lastChannel, ts: p.ts, text: parts.join('\n') })
    .catch(() => {}); // 進度更新失敗不影響任務
});

pool.on('done', async (task) => {
  const channel = state.lastChannel;
  const p = taskProgress.get(task.id);
  taskProgress.delete(task.id);
  if (!channel) {
    console.error(`task #${task.id} 完成但沒有可回報的 channel`);
    return;
  }
  const elapsed = Math.round((task.finishedAt - task.startedAt) / 1000);
  const authDead = !task.ok && isAuthError(task.result);
  const icon = task.ok ? '✅' : authDead ? '🔑' : '❌';
  const statusWord = task.ok ? '完成' : authDead ? '認證失效' : '失敗';
  const headText = `${icon} 背景任務 #${task.id}「${task.description}」${statusWord}(${elapsed}s)`;
  try {
    // 有進度 placeholder 就就地改成完成標頭;沒有就新貼一則。結果回在 thread 裡。
    let headTs;
    if (p) {
      await app.client.chat.update({ channel, ts: p.ts, text: headText });
      headTs = p.ts;
    } else {
      const head = await app.client.chat.postMessage({ channel, text: headText });
      headTs = head.ts;
    }
    if (authDead) {
      await app.client.chat.postMessage({
        channel,
        thread_ts: headTs,
        text: '🔑 請在公司電腦執行 `claude setup-token`,設進 `.env` 的 `CLAUDE_CODE_OAUTH_TOKEN` 後重啟 bot。',
      });
      return;
    }
    await postLongText(app.client, channel, task.result || '(沒有輸出)', headTs);
    // 長任務另發帶 mention 的新訊息觸發手機推播(編輯訊息加 mention 不會推播)
    if (elapsed >= config.mentionMinSeconds) {
      await app.client.chat.postMessage({
        channel,
        text: `<@${state.lastUser}> 🔔 背景任務 #${task.id} ${statusWord}(${elapsed}s),結果在 thread`,
      });
    }
  } catch (err) {
    console.error(`回報 task #${task.id} 失敗:`, err);
  }
});

startDispatchServer({
  port: config.dispatchPort,
  pool,
  getCwd: () => state.cwd,
});

await app.start();
console.log(
  `⚡ bot-remote 已啟動(Socket Mode)\n   工作目錄:${state.cwd}\n   白名單:${config.allowedUserIds.join(', ')}`
);

// Self-heal: exit if Socket Mode emits disconnected and can't reconnect within 5 min.
// Note: zombie TCP connections (NAT idle timeout) are prevented by clientPingTimeout=20s
// in the App constructor above — that sends WebSocket pings every 20s so NAT stays alive.
// This event-based watchdog covers cases where the SDK itself detects the disconnect.
const smClient = app.receiver?.client;
if (smClient) {
  let disconnectedAt = null;
  smClient.on('connected', () => {
    if (disconnectedAt) {
      console.log(`[health] Socket Mode reconnected after ${Math.round((Date.now() - disconnectedAt) / 1000)}s`);
    }
    disconnectedAt = null;
  });
  smClient.on('disconnected', () => {
    if (!disconnectedAt) {
      disconnectedAt = Date.now();
      console.warn('[health] Socket Mode disconnected, watching for reconnect...');
    }
  });
  setInterval(() => {
    if (disconnectedAt) {
      const downMs = Date.now() - disconnectedAt;
      if (downMs > 5 * 60_000) {
        console.error(`[health] Socket Mode down ${Math.round(downMs / 60000)}min, exiting for watchdog restart`);
        process.exit(1);
      }
      console.warn(`[health] Socket Mode still down (${Math.round(downMs / 1000)}s)...`);
    }
  }, 60_000);
} else {
  console.warn('[health] Could not attach Socket Mode health watchdog');
}

// 認證預檢:開機 + 每 6 小時跑一次極小的 claude -p 確認憑證有效。
// token 失效時主動在 Slack 通知,而不是等使用者發訊息才發現每個任務都 401。
const AUTH_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
let lastAuthOk = true;

async function checkAuth(reason) {
  const result = await runAuthPreflight({ claudeCmd: config.claudeCmd, model: config.workerModel });
  if (result.ok) {
    if (!lastAuthOk) {
      lastAuthOk = true;
      await postToLastChannel(`✅ 認證已恢復,bot 重新可用(${reason})`).catch(() => {});
    }
    console.log(`[auth] preflight ok (${reason})`);
    return;
  }
  console.error(`[auth] preflight failed (${reason}): ${result.detail}`);
  // 只在認證問題、且狀態從正常轉為失敗時通知一次,避免洗版
  if (result.authFailed && lastAuthOk) {
    lastAuthOk = false;
    await postToLastChannel(
      '🔑 *認證失效* — bot 無法呼叫 Claude,所有任務都會失敗。\n' +
        '請到公司電腦的互動式終端機執行 `claude setup-token`,把得到的 token 設成 `.env` 的 `CLAUDE_CODE_OAUTH_TOKEN` 後重啟 bot。'
    ).catch(() => {});
  }
}

async function postToLastChannel(text) {
  if (!state.lastChannel) return;
  await app.client.chat.postMessage({ channel: state.lastChannel, text });
}

// 開機延遲 5 秒(等 Slack 連線穩定)後做第一次預檢,之後每 6 小時一次
setTimeout(() => void checkAuth('startup'), 5_000);
setInterval(() => void checkAuth('periodic'), AUTH_CHECK_INTERVAL_MS);

// 每日心跳:每 24 小時報一次「還活著 + 認證狀態 + 背景任務數」,讓你知道服務沒默默掛掉
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60_000;
if (config.heartbeatEnabled) {
  setInterval(() => {
    const status = lastAuthOk ? '認證正常' : '⚠️ 認證失效';
    void postToLastChannel(`💓 bot 運作中 · ${status} · 背景任務 ${pool.running.length} 個執行中`).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
}
