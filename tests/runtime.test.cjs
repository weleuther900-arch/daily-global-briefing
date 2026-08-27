'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPublishableEditorialResult, summarizeModelUsage } = require('../src/runtime.cjs');

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
