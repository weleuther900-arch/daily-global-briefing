'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertPublishableEditorialResult, getImpairedCoverageGroups, hasSentRunForDate, monthlyBudgetForRun, runDaily, summarizeModelUsage } = require('../src/runtime.cjs');
const { isModelInvocationAllowed, isMorningBriefingReady } = require('../src/model-window.cjs');

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

test('云端提前触发只在北京时间07:00至08:30生成正式晨报', () => {
  assert.equal(isMorningBriefingReady(new Date('2026-08-26T22:59:00Z')), false); // 06:59
  assert.equal(isMorningBriefingReady(new Date('2026-08-26T23:00:00Z')), true); // 07:00
  assert.equal(isMorningBriefingReady(new Date('2026-08-27T00:30:00Z')), true); // 08:30
  assert.equal(isMorningBriefingReady(new Date('2026-08-27T00:31:00Z')), false); // 08:31
});

test('提前云端触发在来源窗口未结束时不采集、不调用模型', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dgb-early-'));
  let collected = false;
  const result = await runDaily({
    root,
    mode: 'final',
    now: new Date('2026-08-26T19:00:00Z'), // 北京时间03:00
    requireMorningReadiness: true,
    collectSources: async () => { collected = true; return { coverageGroups: [] }; }
  });
  assert.equal(result.status, 'morning-window-not-ready');
  assert.equal(collected, false);
});

test('夜间恢复任务只在当天未成功投递时运行', () => {
  assert.equal(hasSentRunForDate({ runs: [{ date: '2026-08-28', sent: true }] }, '2026-08-28'), true);
  assert.equal(hasSentRunForDate({ runs: [{ date: '2026-08-28', sent: false }] }, '2026-08-28'), false);
});

test('来源巡检将覆盖不足作为健康状态而不是运行异常', () => {
  const impaired = getImpairedCoverageGroups({ coverageGroups: [
    { id: 'healthy', status: 'available' },
    { id: 'policy', status: 'impaired', availableCount: 3, minimumAvailable: 4 }
  ] });
  assert.deepEqual(impaired, [{ id: 'policy', status: 'impaired', availableCount: 3, minimumAvailable: 4 }]);
});

test('瞬时来源不足时巡检和正式任务均正常结束且不会发送邮件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dgb-coverage-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'sources.v1.json'), JSON.stringify({ sources: [], coverageGroups: [] }));
  const collectSources = async () => ({
    sourceCount: 8,
    itemCount: 100,
    coverageGroups: [{ id: 'policy', name: '中国数字经济与宏观政策', status: 'impaired', availableCount: 3, minimumAvailable: 4 }]
  });
  const scan = await runDaily({ root, mode: 'scan', collectSources });
  const final = await runDaily({ root, mode: 'final', validateOnly: true, collectSources });
  assert.equal(scan.status, 'scan-impaired');
  assert.equal(final.status, 'coverage-stopped');
  assert.equal(scan.sent, undefined);
  assert.equal(final.sent, false);
});
