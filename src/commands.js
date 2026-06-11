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
      return { type: 'stop' };
    case '!model':
      return { type: 'model', model: arg };
    default:
      return { type: 'unknown', name };
  }
}

export const HELP_TEXT = [
  '*bot-remote 指令*',
  '`!cwd <path>` — 切換工作目錄(專案)',
  '`!new` — 重開一個全新 Claude session',
  '`!model <名稱>` — 切換模型(如 `sonnet`、`opus`、`haiku`;不帶參數顯示目前模型,`default` 還原預設)',
  '`!status` — 目前目錄 / session / 佇列狀態',
  '`!stop` — 中斷目前執行中的任務',
  '`!help` — 顯示這份說明',
  '其他訊息都會直接送給 Claude Code 執行。',
].join('\n');
