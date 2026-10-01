'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { addWord, listWords, normalizeMemory, updateWord } = require('../src/memory.cjs');
const { createMemoryServer } = require('../src/memory-server.cjs');

test('旧Day30勾选迁移为Mastered，Day1至Day29保持原状', () => {
  const memory = normalizeMemory({ words: [{ id: 'retention', word: 'retention', day1: true, day29: true, day30: true }] });
  assert.equal(memory.words[0].reviewDays.day1, true);
  assert.equal(memory.words[0].reviewDays.day29, true);
  assert.equal(memory.words[0].mastered, true);
  assert.equal(Object.hasOwn(memory.words[0].reviewDays, 'day30'), false);
});

test('三个目录各自从1连续编号，不受其他目录影响', () => {
  const memory = normalizeMemory({ words: [
    { id: 'one', word: 'one', position: 0 },
    { id: 'two', word: 'two', mastered: true, position: 1 },
    { id: 'three', word: 'three', position: 2 }
  ] });
  assert.deepEqual(listWords(memory, 'All').map(word => word.number), [1, 2, 3]);
  assert.deepEqual(listWords(memory, 'Learning').map(word => [word.word, word.number]), [['one', 1], ['three', 2]]);
  assert.deepEqual(listWords(memory, 'Mastered').map(word => [word.word, word.number]), [['two', 1]]);
});

test('Mastered可以独立切换，不会清除既有Day勾选', () => {
  let memory = normalizeMemory({ words: [{ id: 'leverage', word: 'leverage', reviewDays: { day1: true, day2: true } }] });
  memory = updateWord(memory, 'leverage', { mastered: true });
  assert.equal(memory.words[0].mastered, true);
  assert.equal(memory.words[0].reviewDays.day1, true);
  assert.equal(memory.words[0].reviewDays.day2, true);
  memory = updateWord(memory, 'leverage', { mastered: false });
  assert.equal(memory.words[0].mastered, false);
  assert.equal(memory.words[0].reviewDays.day2, true);
});

test('新增单词默认进入Learning，且无需任何每日学习设定', () => {
  const memory = addWord({ words: [] }, { word: 'robust', meaning: '稳健的' });
  assert.equal(memory.words.length, 1);
  assert.equal(memory.words[0].mastered, false);
  assert.equal(listWords(memory, 'Learning')[0].word, 'robust');
});

test('本地服务保存词库并在读取时迁移旧Day30', async () => {
  const root = path.resolve(__dirname, '..');
  const stateDirectory = fs.mkdtempSync(path.join(root, '.runtime', 'memory-test-'));
  const statePath = path.join(stateDirectory, 'words.json');
  const server = createMemoryServer({ root, statePath });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const endpoint = `http://127.0.0.1:${port}/api/words`;
    const saved = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ words: [{ word: 'signal', day1: true, day30: true }] })
    });
    assert.equal(saved.status, 200);
    const reloaded = await (await fetch(endpoint)).json();
    assert.equal(reloaded.words[0].reviewDays.day1, true);
    assert.equal(reloaded.words[0].mastered, true);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
