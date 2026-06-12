import { createServer } from 'node:http';

// 只綁 127.0.0.1 的派工端點,給 master(claude)用 curl 呼叫:
//   POST /tasks {prompt, description?} -> {id}
//   GET  /tasks -> 任務列表(含狀態與結果開頭)
export function startDispatchServer({ port, pool, getCwd }) {
  const server = createServer((req, res) => {
    const reply = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url === '/tasks') {
      reply(200, { tasks: pool.list() });
      return;
    }
    if (req.method === 'POST' && req.url === '/tasks') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        try {
          const { prompt, description } = JSON.parse(body || '{}');
          if (!prompt) {
            reply(400, { error: 'prompt is required' });
            return;
          }
          const id = pool.dispatch({ prompt, description, cwd: getCwd() });
          reply(200, { id, status: 'running' });
        } catch (err) {
          reply(400, { error: String(err.message || err) });
        }
      });
      return;
    }
    reply(404, { error: 'not found' });
  });

  server.listen(port, '127.0.0.1');
  return server;
}
