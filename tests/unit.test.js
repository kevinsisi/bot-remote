import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, isValidModel } from '../src/commands.js';
import { chunkText, toMrkdwn } from '../src/slack-format.js';

test('parseCommand: 一般訊息回傳 null', () => {
  assert.equal(parseCommand('幫我修這個 bug'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand('not!command'), null);
});

test('parseCommand: 各指令', () => {
  assert.deepEqual(parseCommand('!help'), { type: 'help' });
  assert.deepEqual(parseCommand('!new'), { type: 'new' });
  assert.deepEqual(parseCommand('!status'), { type: 'status' });
  assert.deepEqual(parseCommand('!stop'), { type: 'stop', target: '' });
  assert.deepEqual(parseCommand('!stop 3'), { type: 'stop', target: '3' });
  assert.deepEqual(parseCommand('!cwd D:\\Projects\\foo'), {
    type: 'cwd',
    path: 'D:\\Projects\\foo',
  });
  assert.deepEqual(parseCommand('!cwd'), { type: 'cwd', path: '' });
  assert.deepEqual(parseCommand('  !STATUS  '), { type: 'status' });
  assert.deepEqual(parseCommand('!xyz'), { type: 'unknown', name: '!xyz' });
  assert.deepEqual(parseCommand('!model sonnet'), { type: 'model', model: 'sonnet' });
  assert.deepEqual(parseCommand('!model'), { type: 'model', model: '' });
});

test('isValidModel: 別名與完整 ID 通過,亂打的不過', () => {
  assert.ok(isValidModel('sonnet'));
  assert.ok(isValidModel('OPUS'));
  assert.ok(isValidModel('default'));
  assert.ok(isValidModel('claude-sonnet-4-6'));
  assert.ok(!isValidModel('fable'));
  assert.ok(!isValidModel('sonnet4.6'));
  assert.ok(!isValidModel('gpt-5'));
  assert.ok(!isValidModel(''));
});

test('chunkText: 短文字單塊', () => {
  assert.deepEqual(chunkText('hello\nworld', 100), ['hello\nworld']);
  assert.deepEqual(chunkText('', 100), []);
});

test('chunkText: 依行切塊且每塊不超限', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n');
  const chunks = chunkText(text, 40);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 40);
  assert.equal(chunks.join('\n'), text);
});

test('chunkText: 單行超長會硬切', () => {
  const long = 'x'.repeat(95);
  const chunks = chunkText(long, 40);
  for (const c of chunks) assert.ok(c.length <= 40);
  assert.equal(chunks.join(''), long);
});

test('toMrkdwn: 標題與粗體轉換', () => {
  assert.equal(toMrkdwn('## 標題\n**粗體**字'), '*標題*\n*粗體*字');
  assert.equal(toMrkdwn('普通文字'), '普通文字');
});
