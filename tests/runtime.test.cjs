'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPublishableEditorialResult, monthlyBudgetForRun, summarizeModelUsage } = require('../src/runtime.cjs');
const { isModelInvocationAllowed } = require('../src/model-window.cjs');

test('部分内容被编辑校验拒绝时，保留合格内容继续生成', () => {
  const result = { events: [{ title: '合格事件' }], audit: { rejected: [{ title: '不合格事件', reasons: ['缺少来源'] }] } };
  assert.equal(assertPublishableEditorialResult(result), result);
});

test('编辑校验未留下任何合格内容时停止投递', () => {
  assert.throws(
    () => assertPublishableEditorialResult({ events: [], audit: { rejected: [{ title: '不合格事件', reasons: ['缺少来源'] }] } }),
    /未留下可投递内容（拒绝1条）/
  );
});

test('运行审计汇总模型调用的Token和成本', () => {
  const usage = summarizeModelUsage([
    { model: 'deepseek-v4-flash', inputTokens: 100, outputTokens: 20, cny: 0.01 },
    { model: 'deepseek-v4-pro', inputTokens: 200, outputTokens: 10, cny: 0.02 }
  ]);
  assert.deepEqual(usage, {
    calls: 2, inputTokens: 300, outputTokens: 30, totalTokens: 330, cny: 0.03,
    byModel: {
      'deepseek-v4-flash': { calls: 1, inputTokens: 100, outputTokens: 20, cny: 0.01 },
      'deepseek-v4-pro': { calls: 1, inputTokens: 200, outputTokens: 10, cny: 0.02 }
    }
  });
});

test('硬停止期限内的月度预算为零', () => {
  const environment = { MONTHLY_AI_BUDGET_CNY: '10', AI_HARD_STOP_UNTIL: '2026-09-01T00:00:00+08:00' };
  assert.equal(monthlyBudgetForRun(new Date('2026-08-31T15:00:00Z'), environment), 0);
  assert.equal(monthlyBudgetForRun(new Date('2026-09-01T00:00:00Z'), environment), 10);
});

test('模型调用仅允许在北京时间23:00至08:30', () => {
  assert.equal(isModelInvocationAllowed(new Date('2026-08-26T14:59:00Z')), false); // 22:59
  assert.equal(isModelInvocationAllowed(new Date('2026-08-26T15:00:00Z')), true); // 23:00
  assert.equal(isModelInvocationAllowed(new Date('2026-08-27T00:30:00Z')), true); // 08:30
  assert.equal(isModelInvocationAllowed(new Date('2026-08-27T00:31:00Z')), false); // 08:31
});
