'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clusterCandidates, detectHardExclusion, filterPreviouslySent, MAX_MODEL_SOURCE_EXCERPT_CHARS, prepareModelCandidates, routeCategory, selectEvidenceExcerpt } = require('../src/routing.cjs');

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
  assert.equal(result.candidates[0].sources[0].access, 'open');
});

test('无产业传导的灾害排除，有明确供应链影响时交由编辑判断', () => {
  assert.equal(detectHardExclusion('某地发生7.7级地震，造成伤亡'), 'unrelated-disaster');
  assert.equal(detectHardExclusion('地震导致半导体供应链停产并触发政策调整'), null);
});

test('例行工作会议排除，正式监管决定仍保留给编辑判断', () => {
  assert.equal(detectHardExclusion('第二十六届投洽会筹备工作会议在厦门召开'), 'routine-meeting');
  assert.equal(detectHardExclusion('监管部门正式发布实施方案并作出监管决定'), null);
});

test('相似候选聚类最多保留两个来源，并限制模型原文长度', () => {
  const base = prepareModelCandidates({ items: [detail()] }, '2026-08-17').candidates[0];
  const second = { ...base, title: '人工智能模型推出企业推理服务', sources: [{ ...base.sources[0], url: 'https://example.com/b' }] };
  const third = { ...base, title: '人工智能模型正式推出企业推理服务', sources: [{ ...base.sources[0], url: 'https://example.com/c' }] };
  const result = clusterCandidates([base, second, third]);
  assert.equal(result.length, 1);
  assert.equal(result[0].sources.length, 2);
  const long = prepareModelCandidates({ items: [detail({ text: '甲'.repeat(MAX_MODEL_SOURCE_EXCERPT_CHARS + 100) })] }, '2026-08-17');
  assert.equal(long.candidates[0].sources[0].excerpt.length, MAX_MODEL_SOURCE_EXCERPT_CHARS);
});

test('普通选举诉讼与航空事故不会因来源主题标签混入科技栏目', () => {
  const cases = [
    detail({
      title: '特朗普政府再次向最高法院上诉，要求允许邮寄选票限制',
      text: '联邦地区法院延长禁令，案件涉及邮寄选票限制与选举程序。',
      topics: ['digital-economy', 'ai'],
      url: 'https://example.com/election'
    }),
    detail({
      title: '亚马逊货机在迈阿密机场冲出跑道致多人死亡',
      text: '货机冲出机场跑道并起火，事故原因仍在调查。',
      topics: ['ai', 'digital-economy'],
      url: 'https://example.com/aviation'
    })
  ];
  const result = prepareModelCandidates({ items: cases }, '2026-08-17');
  assert.equal(result.candidateCount, 0);
  assert.equal(result.rejectedCount, 2);
});

test('GitHub受控入口的热门仓库可作为开源生态候选，不依赖描述中的两个关键词', () => {
  const trending = detail({
    sourceId: 'github-trending', sourceName: 'GitHub每日热门项目', sourceTier: 'B', sourceKind: 'community-signal',
    title: 'owner/project', text: 'GitHub Trending 观察时间：2026-08-16T12:00:00.000Z\n仓库：owner/project\n热门页卡片：A compact developer tool 1,234 stars today',
    url: 'https://github.com/owner/project'
  });
  assert.deepEqual(routeCategory(trending), ['open-source-tech', 3, 3]);
  const result = prepareModelCandidates({ items: [trending] }, '2026-08-17');
  assert.equal(result.candidateCount, 1);
  assert.equal(result.candidates[0].category, 'open-source-tech');
});

test('国防采购与弹药库存归入全球经济与政治，不进入开源与技术生态', () => {
  const defense = detail({
    sourceId: 'bbc-world', sourceName: '英国广播公司世界新闻', sourceTier: 'A', sourceKind: 'authoritative-media',
    title: '五角大楼监察机构确认对伊朗战事导致美国弹药短缺',
    text: '美国国防部监察机构确认，战事造成弹药短缺和补给瓶颈。报告提到国防采购、战略库存、生产周期和国防工业基础。',
    topics: ['open-source-tech'], url: 'https://example.com/defense'
  });
  assert.equal(routeCategory(defense)[0], 'global-economy-politics');
  assert.equal(prepareModelCandidates({ items: [defense] }, '2026-08-17').candidates[0].category, 'global-economy-politics');
});

test('证据摘录跳过短导航块并保留正文中的可核验事实', () => {
  const text = ['Home', 'News', 'Search', '投资者关系', '该公司于2026年9月6日发布正式公告，披露本季度收入增长、产品部署范围和后续实施安排，供外部读者核验。'].join('\n');
  const excerpt = selectEvidenceExcerpt(text);
  assert.match(excerpt, /该公司于2026年9月6日发布正式公告/);
  assert.ok(!excerpt.startsWith('Home'));
});

test('十四日发送历史阻止相同事件再次进入模型', () => {
  const prepared = prepareModelCandidates({ items: [detail()] }, '2026-08-17');
  const state = { events: [{ fingerprint: prepared.candidates[0].fingerprint, urls: [], sentAt: new Date().toISOString() }] };
  const filtered = filterPreviouslySent(prepared, state);
  assert.equal(filtered.candidateCount, 0);
  assert.equal(filtered.historicalDuplicates.length, 1);
});
