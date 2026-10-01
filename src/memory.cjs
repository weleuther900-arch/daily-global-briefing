'use strict';

const REVIEW_DAYS = Array.from({ length: 29 }, (_, index) => index + 1);
const MEMORY_TABS = Object.freeze(['All', 'Learning', 'Mastered']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function reviewKey(day) {
  return `day${day}`;
}

function normalizeWord(value, index = 0) {
  const raw = value && typeof value === 'object' ? value : {};
  const reviewDays = {};
  for (const day of REVIEW_DAYS) {
    const key = reviewKey(day);
    reviewDays[key] = Boolean(raw.reviewDays?.[key] ?? raw[key]);
  }
  return {
    id: text(raw.id) || `word-${index + 1}`,
    word: text(raw.word),
    meaning: text(raw.meaning),
    example: text(raw.example),
    reviewDays,
    // 兼容旧表格：Day30 的完成勾选等同于完全掌握。
    mastered: Boolean(raw.mastered ?? raw.day30 ?? raw.reviewDays?.day30),
    position: Number.isFinite(Number(raw.position)) ? Number(raw.position) : index
  };
}

function normalizeMemory(raw) {
  const source = Array.isArray(raw) ? { words: raw } : (raw && typeof raw === 'object' ? raw : {});
  const seen = new Set();
  const words = (Array.isArray(source.words) ? source.words : []).map(normalizeWord).map((word, index) => {
    let id = word.id;
    while (seen.has(id)) id = `${word.id}-${index + 1}`;
    seen.add(id);
    return { ...word, id };
  }).sort((left, right) => left.position - right.position || left.word.localeCompare(right.word));
  return { version: 1, words };
}

function listWords(memory, tab = 'All') {
  if (!MEMORY_TABS.includes(tab)) throw new Error(`未知目录：${tab}`);
  const words = normalizeMemory(memory).words.filter((word) => (
    tab === 'All' || (tab === 'Learning' ? !word.mastered : word.mastered)
  ));
  return words.map((word, index) => ({ ...word, number: index + 1 }));
}

function updateWord(memory, id, patch) {
  const store = normalizeMemory(memory);
  const index = store.words.findIndex((word) => word.id === id);
  if (index < 0) throw new Error('找不到要更新的单词。');
  const current = store.words[index];
  const next = normalizeWord({
    ...current,
    ...patch,
    reviewDays: { ...current.reviewDays, ...(patch?.reviewDays || {}) }
  }, index);
  store.words[index] = { ...next, id: current.id, position: current.position };
  return store;
}

function addWord(memory, input) {
  const store = normalizeMemory(memory);
  const word = text(input?.word);
  if (!word) throw new Error('单词不能为空。');
  const idBase = word.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'word';
  let id = idBase;
  let suffix = 2;
  const existing = new Set(store.words.map((item) => item.id));
  while (existing.has(id)) id = `${idBase}-${suffix++}`;
  store.words.push(normalizeWord({
    id,
    word,
    meaning: input?.meaning,
    example: input?.example,
    position: store.words.length
  }, store.words.length));
  return normalizeMemory(store);
}

module.exports = { REVIEW_DAYS, MEMORY_TABS, addWord, listWords, normalizeMemory, normalizeWord, reviewKey, updateWord };
