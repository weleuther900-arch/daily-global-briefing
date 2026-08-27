'use strict';

const crypto = require('node:crypto');
const { getCoverageWindow, jaccardSimilarity } = require('./pipeline.cjs');

const MAX_MODEL_SOURCES_PER_EVENT = 2;
const MAX_MODEL_SOURCE_EXCERPT_CHARS = 3500;

const KEYWORDS = Object.freeze({
  ai: [
    '人工智能', '大模型', '模型', '推理', '训练', '智能体', '多模态', '算力', 'gpu', 'ai ', ' ai',
    'artificial intelligence', 'machine learning', 'foundation model', 'inference', 'agentic', 'llm', 'nvidia',
    'openai', 'anthropic', 'deepmind', 'gemini', 'claude', 'grok', 'deepseek', 'qwen', '芯片'
  ],
  'digital-economy': [
    '数字经济', '云计算', '数据中心', '半导体', '芯片', '电商', '平台经济', '支付', '金融科技',
    '网络安全', '软件供应链', '卫星互联网', '数字贸易', '数字基础设施', 'cloud', 'semiconductor',
    'cybersecurity', 'fintech', 'e-commerce', 'data center', 'digital market', 'digital services'
  ],
  'china-economy-policy': [
    '中国', '国务院', '国家统计局', '人民银行', '央行', '国家网信办', '监管', '政策', '关税', '进出口',
    '社会融资', '人民币', '国内生产总值', '工业增加值', '固定资产投资', 'china', 'chinese economy'
  ],
  'global-economy-politics': [
    '美联储', '联邦公报', '欧盟', '欧洲委员会', '关税', '制裁', '出口管制', '利率', '通胀', '就业',
    'gdp', 'federal reserve', 'federal register', 'export control', 'tariff', 'sanction', 'inflation',
    'employment', 'monetary policy', 'competition regulation', 'trade policy'
  ],
  'open-source-tech': [
    '开源', 'github', 'repository', 'release', '版本发布', '开发者', '许可证', 'sdk', 'api', '框架',
    'open source', 'developer', 'security advisory', '漏洞'
  ]
});

const EXCLUSION_PATTERNS = Object.freeze({
  'unrelated-disaster': ['earthquake', '地震', '洪水', '台风', '火山', 'wildfire'],
  crime: ['murder', 'homicide', 'robbery', '谋杀', '抢劫', '刑事案件'],
  sports: ['football match', 'basketball', '世界杯', '联赛', '网球公开赛'],
  entertainment: ['celebrity', 'box office', '明星', '票房', '真人秀'],
  'routine-conflict-update': ['troops killed', 'missile strike killed', '战果', '日常战况'],
  'routine-meeting': ['工作会议', '筹备会议', '专题会议', '座谈会', '领导小组会议']
});

const IMPACT_OVERRIDE = [
  'supply chain', '供应链', 'semiconductor', '芯片', 'energy supply', '能源供应', 'port closure', '港口',
  'financial market', '金融市场', 'data center', '数据中心', 'policy response', '政策调整',
  '正式发布', '正式签署', '实施方案', '监管决定', '法规公布'
];

function keywordHits(text, keywords) {
  const normalized = String(text || '').toLowerCase();
  return keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
}

function detectHardExclusion(text) {
  const normalized = String(text || '').toLowerCase();
  if (IMPACT_OVERRIDE.some((keyword) => normalized.includes(keyword.toLowerCase()))) return null;
  for (const [flag, patterns] of Object.entries(EXCLUSION_PATTERNS)) {
    if (patterns.some((pattern) => normalized.includes(pattern.toLowerCase()))) return flag;
  }
  return null;
}

function routeCategory(detail) {
  const text = `${detail.title}\n${detail.text.slice(0, 6000)}`;
  const scores = {};
  for (const [category, keywords] of Object.entries(KEYWORDS)) scores[category] = keywordHits(text, keywords).length;
  for (const topic of detail.topics || []) {
    if (Object.hasOwn(scores, topic)) scores[topic] += 2;
  }
  return Object.entries(scores).sort((left, right) => right[1] - left[1])[0];
}

function createClusterFingerprint(category, title) {
  return crypto.createHash('sha256').update(`${category}|${String(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')}`)
    .digest('hex').slice(0, 20);
}

function makeRoutedCandidate(detail) {
  const [category, score] = routeCategory(detail);
  return {
    category,
    relevanceScore: score,
    fingerprint: createClusterFingerprint(category, detail.title),
    title: detail.title,
    publishedAt: detail.publishedAt,
    sources: [{
      sourceId: detail.sourceId,
      organization: detail.sourceName,
      tier: detail.sourceTier,
      kind: detail.sourceKind,
      title: detail.title,
      url: detail.url,
      publishedAt: detail.publishedAt,
      language: detail.language,
      excerpt: detail.text.slice(0, MAX_MODEL_SOURCE_EXCERPT_CHARS),
      textHash: detail.textHash
    }],
    hasUntrustedInstructions: detail.hasUntrustedInstructions
  };
}

function mergeClusters(left, right) {
  const seen = new Set();
  const sources = [];
  for (const source of [...left.sources, ...right.sources]) {
    if (!seen.has(source.url) && sources.length < MAX_MODEL_SOURCES_PER_EVENT) {
      seen.add(source.url);
      sources.push(source);
    }
  }
  return {
    ...left,
    relevanceScore: Math.max(left.relevanceScore, right.relevanceScore),
    publishedAt: new Date(left.publishedAt) > new Date(right.publishedAt) ? left.publishedAt : right.publishedAt,
    sources,
    hasUntrustedInstructions: left.hasUntrustedInstructions || right.hasUntrustedInstructions
  };
}

function clusterCandidates(candidates) {
  const clusters = [];
  for (const candidate of candidates) {
    const index = clusters.findIndex((cluster) =>
      cluster.category === candidate.category && jaccardSimilarity(cluster.title, candidate.title) >= 0.58
    );
    if (index === -1) clusters.push(candidate);
    else clusters[index] = mergeClusters(clusters[index], candidate);
  }
  return clusters;
}

function prepareModelCandidates(detailResult, briefingDate) {
  const window = getCoverageWindow(briefingDate);
  const accepted = [];
  const rejected = [];
  for (const detail of detailResult.items || []) {
    const reasons = [];
    if (detail.detailStatus !== 'ready') reasons.push('详情内容未达到可分析状态。');
    if (detail.access === 'paid') reasons.push('来源存在付费墙。');
    if (!detail.publishedAt) reasons.push('无法核实公开时间。');
    else {
      const published = new Date(detail.publishedAt);
      if (published < window.start || published >= window.end) reasons.push('不在本期二十四小时窗口内。');
    }
    const fullText = `${detail.title || ''}\n${detail.text || ''}`;
    const exclusion = detectHardExclusion(fullText);
    if (exclusion) reasons.push(`触发硬排除项：${exclusion}。`);
    const routed = detail.detailStatus === 'ready' ? makeRoutedCandidate(detail) : null;
    if (routed && routed.relevanceScore < 2) reasons.push('与约定主题的可解释相关性不足。');
    if (reasons.length > 0) rejected.push({ title: detail.title, url: detail.url, reasons });
    else accepted.push(routed);
  }
  const clusters = clusterCandidates(accepted).sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt));
  return {
    briefingDate,
    coverageStart: window.start.toISOString(),
    coverageEnd: window.end.toISOString(),
    candidateCount: clusters.length,
    rejectedCount: rejected.length,
    candidates: clusters,
    rejected
  };
}

function filterPreviouslySent(candidateResult, sentState, retentionDays = 14) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const recent = (sentState.events || []).filter((event) => new Date(event.sentAt).getTime() >= cutoff);
  const sentFingerprints = new Set(recent.map((event) => event.fingerprint));
  const sentUrls = new Set(recent.flatMap((event) => event.urls || []));
  const candidates = [];
  const duplicates = [];
  for (const candidate of candidateResult.candidates) {
    const urls = candidate.sources.map((source) => source.url);
    const duplicate = sentFingerprints.has(candidate.fingerprint) || urls.every((url) => sentUrls.has(url));
    if (duplicate) duplicates.push({ title: candidate.title, fingerprint: candidate.fingerprint });
    else candidates.push(candidate);
  }
  return { ...candidateResult, candidates, candidateCount: candidates.length, historicalDuplicates: duplicates };
}

module.exports = {
  KEYWORDS,
  MAX_MODEL_SOURCE_EXCERPT_CHARS,
  MAX_MODEL_SOURCES_PER_EVENT,
  clusterCandidates,
  detectHardExclusion,
  filterPreviouslySent,
  prepareModelCandidates,
  routeCategory
};
