import { spawn } from 'node:child_process';

// 認證類錯誤的特徵字串(401 / OAuth 過期 / 未登入 / token 失效)
const AUTH_ERROR_RE =
  /401|invalid authentication|authentication_failed|not logged in|please run \/login|failed to authenticate|oauth_token/i;

export function isAuthError(text) {
  return AUTH_ERROR_RE.test(text || '');
}

// 跑一次極小的 claude -p 確認認證是否有效。
// 回傳 { ok, authFailed, detail }:ok=true 代表認證正常;
// authFailed=true 代表是認證問題(需重設 token),而非其他錯誤。
export function runAuthPreflight({ claudeCmd, model, timeoutMs = 45_000 }) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (model) args.push('--model', model);

    let settled = false;
    let out = '';
    let err = '';

    const child = spawn(claudeCmd, args, { windowsHide: true });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({ ok: false, authFailed: false, detail: `auth preflight timeout ${timeoutMs}ms` });
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      err += d.toString('utf8');
    });
    child.on('error', (e) => finish({ ok: false, authFailed: false, detail: e.message }));
    child.on('close', (code) => {
      const combined = `${out}\n${err}`;
      if (code === 0 && !isAuthError(combined)) {
        finish({ ok: true, authFailed: false, detail: '' });
      } else {
        finish({
          ok: false,
          authFailed: isAuthError(combined),
          detail: (err.trim() || out.trim() || `exit code ${code}`).slice(0, 500),
        });
      }
    });

    child.stdin.write('reply with: ok', 'utf8');
    child.stdin.end();
  });
}
