import pkg from '@slack/bolt';
import { existsSync, statSync } from 'node:fs';
import { config } from './config.js';
import { loadState, saveState } from './state.js';
import { parseCommand, HELP_TEXT } from './commands.js';
import {
  toMrkdwn,
  chunkText,
  FILE_UPLOAD_THRESHOLD,
} from './slack-format.js';
import { ClaudeRunner } from './claude-runner.js';

const { App } = pkg;

const state = loadState({ sessionId: null, cwd: config.defaultCwd, model: null });
const runner = new ClaudeRunner({
  claudeCmd: config.claudeCmd,
  taskTimeoutMs: config.taskTimeoutMs,
  workerModel: config.workerModel,
});

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

app.message(async ({ message, client }) => {
  // 只處理一般文字訊息(排除 bot、編輯、加入頻道等 subtype)
  if (message.subtype || message.bot_id) return;
  if (config.channelId && message.channel !== config.channelId) return;
  if (!config.allowedUserIds.includes(message.user)) return;

  const text = (message.text || '').trim();
  if (!text) return;

  const channel = message.channel;
  const command = parseCommand(text);
  if (command) {
    await handleCommand(command, channel, client);
    return;
  }

  const placeholder = await client.chat.postMessage({
    channel,
    text: runner.isRunning ? '🕐 已排隊…' : '⏳ 執行中…',
  });
  runner.enqueue(buildTask(text, channel, client, placeholder.ts));
});

const PROGRESS_SNIPPET_LIMIT = 500;

function truncateForProgress(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PROGRESS_SNIPPET_LIMIT
    ? `…${flat.slice(-PROGRESS_SNIPPET_LIMIT)}`
    : flat;
}

function buildTask(prompt, channel, client, placeholderTs) {
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
      const header = result.ok ? `✅ 完成(${elapsed}s)` : `❌ 失敗(${elapsed}s)`;
      try {
        await client.chat.update({ channel, ts: placeholderTs, text: header });
        await postLongText(client, channel, result.text || '(沒有輸出)');
      } catch (err) {
        console.error('回貼 Slack 失敗:', err);
      }
    },
  };
}

async function postLongText(client, channel, raw) {
  if (raw.length > FILE_UPLOAD_THRESHOLD) {
    await client.filesUploadV2({
      channel_id: channel,
      filename: 'claude-output.md',
      content: raw,
      initial_comment: '輸出過長,改附檔案:',
    });
    return;
  }
  for (const chunk of chunkText(toMrkdwn(raw))) {
    await client.chat.postMessage({ channel, text: chunk });
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
        ].join('\n')
      );
      break;
    case 'model': {
      if (!command.model) {
        await say(`🤖 目前模型:\`${state.model || '(預設)'}\``);
        break;
      }
      state.model = command.model.toLowerCase() === 'default' ? null : command.model;
      saveState(state);
      await say(`🤖 已切換模型:\`${state.model || '(預設)'}\`(下一則訊息生效)`);
      break;
    }
    case 'stop':
      await say(runner.stop() ? '🛑 已送出中斷' : '目前沒有執行中的任務');
      break;
    default:
      await say(`不認識的指令 \`${command.name}\`,輸入 \`!help\` 看用法`);
  }
}

await app.start();
console.log(
  `⚡ bot-remote 已啟動(Socket Mode)\n   工作目錄:${state.cwd}\n   白名單:${config.allowedUserIds.join(', ')}`
);
