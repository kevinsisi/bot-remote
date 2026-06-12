// 煙霧測試:確認 orchestrator 會把實作工作派給 worker(觀察 Task tool_use 事件)
// 用法:node scripts/smoke-dispatch.mjs
import { spawn } from 'node:child_process';

const ORCH = (await import('../src/claude-runner.js')).ClaudeRunner; // 確保模組可載入
void ORCH;

const prompt =
  '摘要 D:\\Projects\\_HomeProject\\bot-remote\\src 裡每個檔案的職責,各一句話';

// 與 claude-runner 相同的參數組合(獨立組裝,避免為了測試暴露內部)
const { config } = await import('../src/config.js');
const args = [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--dangerously-skip-permissions',
  '--append-system-prompt',
  '最高原則:把你自己的 token 用量降到最低。凡是需要讀檔案、寫程式、跑指令、搜尋、研究、分析的工作,一律用 Task 工具派給 worker agent。',
  '--agents', JSON.stringify({
    worker: {
      description: 'General-purpose executor. Use proactively for heavy lifting.',
      prompt: 'Complete the assigned task fully and return a concise result.',
      model: config.workerModel,
    },
  }),
  '--model', 'claude-fable-5',
];

const child = spawn('claude', args, { cwd: 'D:/tmp', windowsHide: true });
let buf = '';
let dispatches = 0;
let result = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'assistant') {
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_use' && b.name === 'Task') {
            dispatches++;
            console.log(`[dispatch #${dispatches}]`, b.input?.subagent_type, '-', (b.input?.description || '').slice(0, 60));
          }
        }
      }
      if (ev.type === 'result') result = ev.result ?? '';
    } catch {}
  }
});
child.on('close', () => {
  console.log('---');
  console.log('worker dispatches:', dispatches);
  console.log('result head:', result.slice(0, 200));
  process.exit(dispatches > 0 ? 0 : 1);
});
child.stdin.write(prompt);
child.stdin.end();
