'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendCost, assertBudget, assertDailyTokenBudget, calculateCost, dayKey, estimateTokens, getDayTokenSpend, getMonthSpend, monthKey } = require('../src/cost.cjs');

test('GPT-5 mini费用按照输入输出分别计算', () => {
  const cost = calculateCost('gpt-5-mini', 1_000_000, 1_000_000, 7.2);
  assert.equal(cost.usd, 2.25);
  assert.equal(cost.cny, 16.2);
  assert.ok(estimateTokens('中文内容') > 0);
});

test('DeepSeek V4 Flash按保守的未命中缓存价格计算', () => {
  const cost = calculateCost('deepseek-v4-flash', 1_000_000, 1_000_000, 7.2);
  assert.ok(Math.abs(cost.usd - 0.42) < 1e-10);
  assert.ok(Math.abs(cost.cny - 3.024) < 1e-10);
});

test('月度费用门禁在调用前阻止超额', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dgb-cost-'));
  const ledger = path.join(directory, 'ledger.json');
  appendCost(ledger, { cny: 9.8, recordedAt: new Date().toISOString() });
  assert.equal(getMonthSpend(JSON.parse(fs.readFileSync(ledger, 'utf8'))) >= 9.8, true);
  assert.throws(() => assertBudget(ledger, { cny: 0.3 }, 10), /费用门禁拒绝调用/);
});

test('月度门禁使用预留成本而不是实际成本', () => {
  assert.equal(getMonthSpend({ entries: [{ month: new Date().toISOString().slice(0, 7), cny: 0.5, budgetCny: 1 }] }), 1);
});

test('每日Token门禁在调用前阻止超额', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dgb-token-'));
  const ledger = path.join(directory, 'ledger.json');
  appendCost(ledger, { inputTokens: 120000, outputTokens: 10000, recordedAt: new Date().toISOString() });
  assert.equal(getDayTokenSpend(JSON.parse(fs.readFileSync(ledger, 'utf8'))), 130000);
  assert.throws(() => assertDailyTokenBudget(ledger, { inputTokens: 15000, outputTokens: 10000 }, 150000), (error) => error.code === 'DAILY_TOKEN_BUDGET_EXCEEDED');
});

test('成本账本按北京时间而非UTC跨日', () => {
  assert.equal(dayKey(new Date('2026-08-29T18:49:00.000Z')), '2026-08-30');
  assert.equal(monthKey(new Date('2026-08-31T16:30:00.000Z')), '2026-09');
  const ledger = { entries: [
    { recordedAt: '2026-08-29T18:49:00.000Z', inputTokens: 100, outputTokens: 20 },
    { recordedAt: '2026-08-29T15:49:00.000Z', inputTokens: 900, outputTokens: 20 }
  ] };
  assert.equal(getDayTokenSpend(ledger, '2026-08-30'), 120);
});
