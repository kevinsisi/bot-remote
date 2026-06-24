// 解析 "!" 開頭的控制指令。非控制指令回傳 null(交給 Claude)。
export function parseCommand(text) {
  const trimmed = (text || '').trim();
  if (!trimmed.startsWith('!')) return null;

  const space = trimmed.indexOf(' ');
  const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const arg = space === -1 ? '' : trimmed.slice(space + 1).trim();

  switch (name) {
    case '!help':
      return { type: 'help' };
    case '!new':
      return { type: 'new' };
    case '!cwd':
      return { type: 'cwd', path: arg };
    case '!status':
      return { type: 'status' };
    case '!stop':
      return { type: 'stop', target: arg };
    case '!model':
      return { type: 'model', model: arg };
    default:
      return { type: 'unknown', name };
  }
}

// 允許的模型:別名(永遠指向該系列最新版)+ 已知完整 ID
export const KNOWN_MODELS = [
  'opus',
  'sonnet',
  'haiku',
  'default',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

export function isValidModel(name) {
  return KNOWN_MODELS.includes((name || '').toLowerCase());
}

export const MODEL_LIST_TEXT = [
  '*可用模型*',
  '`opus` → Opus 4.8(claude-opus-4-8)',
  '`sonnet` → Sonnet 4.6(claude-sonnet-4-6)',
  '`haiku` → Haiku 4.5(claude-haiku-4-5-20251001)',
  '`default` → 還原 Claude Code 預設',
  '別名會自動指向該系列最新版;也可以直接用上面括號裡的完整 ID。',
].join('\n');

export const HELP_TEXT = [
  '*bot-remote 指令*',
  '`!cwd <path>` — 切換工作目錄(專案),不帶參數顯示目前目錄',
  '`!new` — 重開一個全新 Claude session',
  '`!model <名稱>` — 切換主模型(`opus` / `sonnet` / `haiku` / `default`);不帶參數顯示目前模型',
  '`!status` — 目前目錄 / session / 模型 / 佇列 / 背景任務狀態',
  '`!stop` — 中斷主任務;`!stop <編號>` — 停掉指定的背景任務',
  '`!help` — 顯示這份說明',
  '其他訊息都會直接送給 Claude Code 執行(粗重工作會自動派給 worker agent 平行處理)。',
].join('\n');
