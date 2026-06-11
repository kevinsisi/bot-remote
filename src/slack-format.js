// Slack 單則訊息上限 4000 字,留安全餘裕。
export const SLACK_CHUNK_LIMIT = 3900;
// 超過這個長度改用檔案上傳,避免洗版。
export const FILE_UPLOAD_THRESHOLD = 12000;

// 最小化 Markdown → Slack mrkdwn 轉換:粗體與標題。
// 不處理巢狀/邊角語法 — 顯示稍醜可接受,內容正確優先。
export function toMrkdwn(text) {
  return (text || '')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
}

// 依行切塊,單行超長再硬切,確保每塊 <= limit。
export function chunkText(text, limit = SLACK_CHUNK_LIMIT) {
  if (!text) return [];
  const chunks = [];
  let current = '';

  for (const line of text.split('\n')) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) {
        const piece = line.slice(i, i + limit);
        if (piece.length === limit) chunks.push(piece);
        else current = piece;
      }
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
