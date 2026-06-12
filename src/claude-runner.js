import { spawn } from 'node:child_process';

// 主對話是 orchestrator,以最低 token 運行;粗重工作派到背景任務池後「立刻回覆」,
// 不等結果——結果由 bot 自動回報到 Slack。
function buildOrchestratorPrompt(dispatchPort) {
  return (
    '你是透過 Slack 橋接被遠端操控的協調者(orchestrator),跑在使用者的公司電腦上。' +
    '最高原則:把你自己的 token 用量降到最低,並且讓每一輪回覆都在幾秒內結束。' +
    '(1) 凡是需要讀檔案、寫程式、跑指令、搜尋、研究、分析的工作,用 Bash 執行 ' +
    `curl -s -X POST http://127.0.0.1:${dispatchPort}/tasks -H "Content-Type: application/json" ` +
    `-d '{"prompt":"<完整且自包含的任務描述>","description":"<10字內摘要>"}' 派成背景任務;` +
    '派完「立刻」告訴使用者你派了哪些任務(附編號),然後結束這一輪——絕對不要等待任務完成,' +
    '系統會在任務做完時自動把結果貼回 Slack。' +
    `(2) 使用者問背景任務進度時,用 curl -s http://127.0.0.1:${dispatchPort}/tasks 查詢後摘要回報。` +
    '(3) 彼此獨立的工作就拆成多個背景任務一次派出去。' +
    '(4) prompt 必須自包含(含完整路徑與目標),因為 worker 看不到這段對話。' +
    '(5) 只有純對話、或 10 秒內能答完的小事才自己直接做。' +
    '(6) 回覆顯示在 Slack 手機畫面,保持精簡,給結論和重點,不要貼大段程式碼。'
  );
}


// 一次只跑一個 Claude 任務的 FIFO 佇列。
// 事件透過 callbacks 回報:onProgress(text)、最終 resolve {ok, text, sessionId}。
export class ClaudeRunner {
  constructor({ claudeCmd, taskTimeoutMs, workerModel, dispatchPort }) {
    this.claudeCmd = claudeCmd;
    this.taskTimeoutMs = taskTimeoutMs;
    this.workerModel = workerModel;
    this.dispatchPort = dispatchPort;
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
        '--append-system-prompt', buildOrchestratorPrompt(this.dispatchPort),
      ];
      if (task.sessionId) args.push('--resume', task.sessionId);
      if (task.model) args.push('--model', task.model);

      // claude 是原生 exe,直接 spawn(不走 cmd shell,JSON 參數才不會被引號規則弄壞)
      const child = spawn(this.claudeCmd, args, {
        cwd: task.cwd,
        windowsHide: true,
      });
      this.current = { child, startedAt: Date.now() };

      let sessionId = task.sessionId || null;
      let resultText = null;
      let isError = false;
      let stderrBuf = '';
      let lineBuf = '';
      let settled = false;

      // taskTimeoutMs = 0 表示不限時,長任務交給使用者用 !stop 控制
      const timeout = this.taskTimeoutMs
        ? setTimeout(() => {
            stderrBuf += `\n[bot-remote] 任務超過 ${Math.round(this.taskTimeoutMs / 60000)} 分鐘,已強制終止`;
            killTree(child);
          }, this.taskTimeoutMs)
        : null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
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
            const { text, thinking } = extractAssistantContent(event);
            if (text || thinking) task.onProgress?.({ text, thinking });
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

function extractAssistantContent(event) {
  const content = event.message?.content;
  if (!Array.isArray(content)) return { text: '', thinking: '' };
  const pick = (type, field) =>
    content
      .filter((block) => block.type === type)
      .map((block) => block[field])
      .filter(Boolean)
      .join('');
  return { text: pick('text', 'text'), thinking: pick('thinking', 'thinking') };
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // claude 會再 spawn 自己的子程序(含 worker agent),要殺整棵 process tree
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}
