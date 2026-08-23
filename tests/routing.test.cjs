'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clusterCandidates, detectHardExclusion, filterPreviouslySent, prepareModelCandidates, routeCategory } = require('../src/routing.cjs');

function detail(overrides = {}) {
  return {
    sourceId: 'official', sourceName: '官方机构', sourceTier: 'S', sourceKind: 'government', topics: [],
    title: '人工智能模型推出企业级推理服务', url: 'https://example.com/a', publishedAt: '2026-08-16T12:00:00Z',
    language: 'zh-CN', text: '人工智能模型面向企业推出正式推理服务，披露定价、计算成本、开发者接口和数据中心部署计划。',
    textHash: 'abc', detailStatus: 'ready', access: 'open', hasUntrustedInstructions: false, ...overrides
  };
}

test('候选按主题路由并只保留固定二十四小时窗口', () => {
  assert.equal(routeCategory(detail())[0], 'ai');
  const result = prepareModelCandidates({ items: [detail(), detail({ title: '旧内容', url: 'https://example.com/old', publishedAt: '2026-08-14T12:00:00Z' })] }, '2026-08-17');
  assert.equal(result.candidateCount, 1);
  assert.equal(result.rejectedCount, 1);
});

test('无产业传导的灾害排除，有明确供应链影响时交由编辑判断', () => {
  assert.equal(detectHardExclusion('某地发生7.7级地震，造成伤亡'), 'unrelated-disaster');
  assert.equal(detectHardExclusion('地震导致半导体供应链停产并触发政策调整'), null);
});

test('例行工作会议排除，正式监管决定仍保留给编辑判断', () => {
  assert.equal(detectHardExclusion('第二十六届投洽会筹备工作会议在厦门召开'), 'routine-meeting');
  assert.equal(detectHardExclusion('监管部门正式发布实施方案并作出监管决定'), null);
});

test('相似候选聚类并合并来源', () => {
  const base = prepareModelCandidates({ items: [detail()] }, '2026-08-17').candidates[0];
  const second = { ...base, title: '人工智能模型推出企业推理服务', sources: [{ ...base.sources[0], url: 'https://example.com/b' }] };
  const result = clusterCandidates([base, second]);
  assert.equal(result.length, 1);
  assert.equal(result[0].sources.length, 2);
});

test('十四日发送历史阻止相同事件再次进入模型', () => {
  const prepared = prepareModelCandidates({ items: [detail()] }, '2026-08-17');
  const state = { events: [{ fingerprint: prepared.candidates[0].fingerprint, urls: [], sentAt: new Date().toISOString() }] };
  const filtered = filterPreviouslySent(prepared, state);
  assert.equal(filtered.candidateCount, 0);
  assert.equal(filtered.historicalDuplicates.length, 1);
});
