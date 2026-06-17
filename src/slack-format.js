// Slack 單則訊息上限 4000 字,留安全餘裕。
export const SLACK_CHUNK_LIMIT = 3900;
// 超過這個長度改用檔案上傳,避免洗版。
export const FILE_UPLOAD_THRESHOLD = 12000;

// Markdown → Slack mrkdwn 轉換。
// Slack 不支援表格、水平線、code fence 語言標籤 — 處理這些以減少雜訊。
export function toMrkdwn(text) {
  if (!text) return '';

  const lines = text.split('\n');
  const out = [];
  let inTable = false;
  let inCodeFence = false;

  for (const line of lines) {
    // Track code fences so we don't transform content inside them
    if (/^```/.test(line)) {
      if (!inCodeFence) {
        inCodeFence = true;
        // Strip language specifier (```python → ```) — Slack ignores it anyway
        out.push('```');
        continue;
      } else {
        inCodeFence = false;
        out.push('```');
        continue;
      }
    }

    if (inCodeFence) {
      out.push(line);
      continue;
    }

    const trimmed = line.trim();

    // Table rows start with |
    const isTableRow = trimmed.startsWith('|');
    // Separator rows like |---|:---:|--- contain only |, -, :, space
    const isSeparatorRow = isTableRow && /^\|[\s\-|:]+\|?$/.test(trimmed);

    if (isTableRow) {
      if (!inTable) {
        out.push('```');
        inTable = true;
      }
      if (!isSeparatorRow) out.push(line); // skip |---|---| rows
      continue;
    }

    if (inTable) {
      out.push('```');
      inTable = false;
    }

    // Horizontal rules → blank line
    if (/^[-*_]{3,}$/.test(trimmed)) {
      out.push('');
      continue;
    }

    // Headings → bold
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      out.push(`*${headingMatch[1]}*`);
      continue;
    }

    // **bold** → *bold*
    out.push(line.replace(/\*\*([^*\n]+)\*\*/g, '*$1*'));
  }

  if (inTable) out.push('```');

  return out.join('\n');
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
