import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'data',
  'state.json'
);

export function loadState(defaults) {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return { ...defaults, ...raw };
  } catch {
    return { ...defaults };
  }
}

export function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}
