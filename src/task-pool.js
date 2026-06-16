import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const MAX_BACKGROUND_TASKS = 10;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000]; // backoff per attempt

// Claude API transient errors worth retrying (5xx, overloaded, timeout)
function isTransient(text) {
  return /API Error: 5\d\d|overloaded|529|503|502|timed? ?out/i.test(text || '');
}

const WORKER_PROMPT =
  '你是被 orchestrator 派遣的背景 worker,跑在使用者的公司電腦上。' +
  '獨立完成指派的任務、驗證你的成果,然後精簡回報結論與重點。';

// 背景任務池:每個任務一個獨立的 claude -p,平行執行,完成時 emit('done', task)。
export class TaskPool extends EventEmitter {
  constructor({ claudeCmd, workerModel }) {
    super();
    this.claudeCmd = claudeCmd;
    this.workerModel = workerModel;
    this.tasks = new Map(); // id -> { id, description, status, startedAt, ... }
    this.nextId = 1;
  }

  get running() {
    return [...this.tasks.values()].filter((t) => t.status === 'running');
  }

  list() {
    return [...this.tasks.values()].map((t) => ({
      id: t.id,
      description: t.description,
      status: t.status,
      elapsedSec: Math.round(((t.finishedAt || Date.now()) - t.startedAt) / 1000),
      resultHead: (t.result || '').slice(0, 300),
    }));
  }

  // 回傳 task id;超過上限丟錯誤讓呼叫端(master)知道。
  dispatch({ prompt, description, cwd }) {
    if (this.running.length >= MAX_BACKGROUND_TASKS) {
      throw new Error(`背景任務已達上限 ${MAX_BACKGROUND_TASKS} 個,請等部分完成後再派`);
    }
    const id = this.nextId++;
    const task = {
      id,
      description: description || prompt.slice(0, 80),
      prompt,
      cwd,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      ok: null,
      attempt: 0,
    };
    this.tasks.set(id, task);
    this.#run(task);
    return id;
  }

  #run(task) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--append-system-prompt', WORKER_PROMPT,
      '--model', this.workerModel,
    ];
    const child = spawn(this.claudeCmd, args, { cwd: task.cwd, windowsHide: true });
    task.child = child;

    let lineBuf = '';
    let resultText = null;
    let isError = false;
    let stderrBuf = '';

    child.stdout.on('data', (data) => {
      lineBuf += data.toString('utf8');
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') {
            resultText = event.result ?? '';
            isError = Boolean(event.is_error);
          }
        } catch {
          // 非 JSON 行略過
        }
      }
    });
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString('utf8');
    });

    const finish = (ok, text) => {
      if (task.status !== 'running') return;
      task.status = ok ? 'done' : 'error';
      task.ok = ok;
      task.result = text;
      task.finishedAt = Date.now();
      task.child = null;
      this.emit('done', task);
    };

    child.on('error', (err) => finish(false, `無法啟動 worker:${err.message}`));
    child.on('close', (code) => {
      if (resultText !== null && !isError) {
        finish(true, resultText);
        return;
      }
      const errText = [resultText, stderrBuf.trim(), `exit code: ${code}`].filter(Boolean).join('\n');
      // Retry on transient Claude API errors (5xx / overloaded)
      if (isTransient(errText) && task.attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[task.attempt] ?? 30_000;
        task.attempt += 1;
        console.warn(`[task #${task.id}] transient error, retry ${task.attempt}/${MAX_RETRIES} in ${delay / 1000}s`);
        setTimeout(() => this.#run(task), delay);
      } else {
        finish(false, errText);
      }
    });

    child.stdin.write(task.prompt, 'utf8');
    child.stdin.end();
  }
}
