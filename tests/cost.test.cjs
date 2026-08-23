'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { appendCost, assertBudget, calculateCost, estimateTokens, getMonthSpend } = require('../src/cost.cjs');

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
