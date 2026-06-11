import { spawn } from 'node:child_process';

// 一次只跑一個 Claude 任務的 FIFO 佇列。
// 事件透過 callbacks 回報:onProgress(text)、最終 resolve {ok, text, sessionId}。
export class ClaudeRunner {
  constructor({ claudeCmd, taskTimeoutMs }) {
    this.claudeCmd = claudeCmd;
    this.taskTimeoutMs = taskTimeoutMs;
    this.queue = [];
    this.current = null; // { child, prompt, startedAt }
  }

  get queueLength() {
    return this.queue.length;
  }

  get isRunning() {
    return this.current !== null;
  }

  // 回傳排隊位置(0 = 立即執行)。
  enqueue(task) {
    this.queue.push(task);
    const position = this.queue.length - 1 + (this.isRunning ? 1 : 0);
    if (!this.isRunning) void this.#drain();
    return position;
  }

  stop() {
    if (!this.current) return false;
    killTree(this.current.child);
    return true;
  }

  async #drain() {
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      try {
        const result = await this.#run(task);
        await task.onDone(result);
      } catch (err) {
        await task.onDone({ ok: false, text: String(err?.stack || err), sessionId: null });
      }
    }
  }

  #run(task) {
    return new Promise((resolve) => {
      const args = [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--dangerously-skip-permissions',
      ];
      if (task.sessionId) args.push('--resume', task.sessionId);

      const child = spawn(this.claudeCmd, args, {
        cwd: task.cwd,
        shell: process.platform === 'win32', // Windows 上 claude 是 .cmd shim
        windowsHide: true,
      });
      this.current = { child, startedAt: Date.now() };

      let sessionId = task.sessionId || null;
      let resultText = null;
      let isError = false;
      let stderrBuf = '';
      let lineBuf = '';
      let settled = false;

      const timeout = setTimeout(() => {
        stderrBuf += `\n[bot-remote] 任務超過 ${Math.round(this.taskTimeoutMs / 60000)} 分鐘,已強制終止`;
        killTree(child);
      }, this.taskTimeoutMs);

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.current = null;
        resolve(result);
      };

      child.stdout.on('data', (data) => {
        lineBuf += data.toString('utf8');
        let nl;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (!line) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue; // 非 JSON 行(雜訊)直接略過
          }
          if (event.session_id) sessionId = event.session_id;
          if (event.type === 'assistant') {
            const text = extractAssistantText(event);
            if (text) task.onProgress?.(text);
          } else if (event.type === 'result') {
            resultText = event.result ?? '';
            isError = Boolean(event.is_error);
          }
        }
      });

      child.stderr.on('data', (data) => {
        stderrBuf += data.toString('utf8');
      });

      child.on('error', (err) => {
        finish({
          ok: false,
          text: `無法啟動 Claude CLI(${this.claudeCmd}):${err.message}`,
          sessionId,
        });
      });

      child.on('close', (code) => {
        if (resultText !== null && !isError) {
          finish({ ok: true, text: resultText, sessionId });
        } else {
          const detail = [resultText, stderrBuf.trim(), `exit code: ${code}`]
            .filter(Boolean)
            .join('\n');
          finish({ ok: false, text: detail, sessionId });
        }
      });

      // prompt 走 stdin,避免 shell quoting 問題
      child.stdin.write(task.prompt, 'utf8');
      child.stdin.end();
    });
  }
}

function extractAssistantText(event) {
  const content = event.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // shell:true 時 child 是 cmd 包裝,要殺整棵 process tree
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}
