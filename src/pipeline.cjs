'use strict';

const crypto = require('node:crypto');
const { PROJECT_CONFIG } = require('./config.cjs');

function parseBriefingDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) throw new Error('briefingDate必须使用YYYY-MM-DD格式。');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('briefingDate不是有效日期。');
  }
  return { year, month, day };
}

function getCoverageWindow(briefingDate, config = PROJECT_CONFIG) {
  const { year, month, day } = parseBriefingDate(briefingDate);
  const endUtcMs = Date.UTC(year, month - 1, day, config.cutoffHour - config.utcOffsetHours, 0, 0, 0);
  const startUtcMs = endUtcMs - 24 * 60 * 60 * 1000;
  return {
    start: new Date(startUtcMs),
    end: new Date(endUtcMs),
    label: `${formatBeijingDateTime(new Date(startUtcMs))}—${formatBeijingDateTime(new Date(endUtcMs))}`
  };
}

function formatBeijingDateTime(date, config = PROJECT_CONFIG) {
  const adjusted = new Date(date.getTime() + config.utcOffsetHours * 60 * 60 * 1000);
  const year = adjusted.getUTCFullYear();
  const month = String(adjusted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(adjusted.getUTCDate()).padStart(2, '0');
  const hour = String(adjusted.getUTCHours()).padStart(2, '0');
  const minute = String(adjusted.getUTCMinutes()).padStart(2, '0');
  return `${year}年${month}月${day}日 ${hour}:${minute}`;
}

function canonicalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm$|from$|source$|ref$|campaign$)/i.test(key)) url.searchParams.delete(key);
    }
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return value;
  }
}

function canonicalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function titleTokens(value) {
  const normalized = canonicalizeTitle(value);
  const tokens = new Set();
  const latinWords = String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const word of latinWords) tokens.add(word);
  for (const character of normalized) {
    if (/\p{Script=Han}/u.test(character)) tokens.add(character);
  }
  for (let index = 0; index < normalized.length - 1; index += 1) {
    tokens.add(normalized.slice(index, index + 2));
  }
  if (normalized.length === 1) tokens.add(normalized);
  return tokens;
}

function jaccardSimilarity(left, right) {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function createEventFingerprint(event) {
  const stableKey = event.eventKey || `${event.category}|${canonicalizeTitle(event.title)}`;
  return crypto.createHash('sha256').update(stableKey).digest('hex').slice(0, 20);
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

function scoreEvent(event) {
  const dimensions = event.importance || {};
  return ['scope', 'magnitude', 'duration', 'relevance', 'evidence']
    .reduce((total, key) => total + Math.max(0, Math.min(2, Number(dimensions[key]) || 0)), 0);
}

function validateEvent(event, window, config = PROJECT_CONFIG) {
  const errors = [];
  const categoryIds = new Set(config.categories.map((category) => category.id));

  if (!event || typeof event !== 'object') return ['候选事件不是对象。'];
  if (!categoryIds.has(event.category)) errors.push('栏目不在第一版允许范围内。');
  if (!event.title || !event.conclusion) errors.push('缺少标题或一句话结论。');
  if (event.editorialDecision !== 'include') errors.push('编辑决定不是include。');

  const publishedAt = new Date(event.publishedAt);
  if (Number.isNaN(publishedAt.getTime())) {
    errors.push('publishedAt不是有效时间。');
  } else if (publishedAt < window.start || publishedAt >= window.end) {
    errors.push('公开时间不在本期二十四小时窗口内。');
  }

  if (!config.allowedEvidenceStatuses.includes(event.evidenceStatus)) {
    errors.push('证据状态不允许进入成稿。');
  }

  const sources = Array.isArray(event.sources) ? event.sources : [];
  if (sources.length === 0) errors.push('没有公开原始来源。');
  if (sources.length > config.displaySourceLimit) errors.push(`普通晨报最多展示${config.displaySourceLimit}个来源。`);
  if (sources.some((source) => source.access !== 'open')) errors.push('包含付费或不可公开访问的来源。');
  if (sources.some((source) => !source.organization || !source.title || !/^https:\/\//i.test(source.url || ''))) {
    errors.push('来源缺少机构、中文标题或HTTPS链接。');
  }

  if (event.evidenceStatus === 'authoritative-exclusive') {
    const allowed = sources.some((source) => config.authoritativeExclusiveOrganizations.includes(source.organization));
    if (!allowed) errors.push('未确认独家报道不是路透社或美联社来源。');
    if (!event.evidenceNote) errors.push('未确认独家报道缺少证据状态说明。');
  }

  const flags = Array.isArray(event.exclusionFlags) ? event.exclusionFlags : [];
  const blockedFlags = flags.filter((flag) => config.hardExclusionFlags.includes(flag));
  if (blockedFlags.length > 0) errors.push(`触发排除项：${blockedFlags.join('、')}。`);

  if (event.includeReason === 'high-attention') {
    const checks = event.highAttentionChecks || {};
    if (!checks.publicAttention || !checks.originalMaterial || !checks.informationDensity || !checks.topicRelevance) {
      errors.push('高关注度事件没有同时通过四项门槛。');
    }
  }

  const allText = collectStrings({
    title: event.title,
    conclusion: event.conclusion,
    sections: event.sections,
    concepts: event.concepts,
    formula: event.formula,
    watch: event.watch,
    sources: (event.sources || []).map((source) => ({ organization: source.organization, title: source.title }))
  }).join('\n');
  if (allText.includes('*')) errors.push('正文包含星号，违反正式邮件排版规范。');

  const sourceUrls = new Set(sources.map((source) => canonicalizeUrl(source.url)));
  const criticalFacts = Array.isArray(event.criticalFacts) ? event.criticalFacts : [];
  if (criticalFacts.length === 0) errors.push('没有逐项登记关键事实与来源绑定。');
  for (const fact of criticalFacts) {
    if (!fact.claim || !Array.isArray(fact.sourceUrls) || fact.sourceUrls.length === 0) {
      errors.push('存在未绑定来源的关键事实。');
      continue;
    }
    if (fact.sourceUrls.some((url) => !sourceUrls.has(canonicalizeUrl(url)))) {
      errors.push('关键事实绑定了未展示或未知的来源。');
    }
  }

  return [...new Set(errors)];
}

function mergeDuplicateEvents(primary, secondary, config = PROJECT_CONFIG) {
  const sources = [];
  const seen = new Set();
  for (const source of [...(primary.sources || []), ...(secondary.sources || [])]) {
    const url = canonicalizeUrl(source.url);
    if (!seen.has(url) && sources.length < config.displaySourceLimit) {
      seen.add(url);
      sources.push({ ...source, url });
    }
  }
  const tags = [...new Set([...(primary.tags || []), ...(secondary.tags || [])])];
  return { ...primary, sources, tags };
}

function deduplicateEvents(events, config = PROJECT_CONFIG) {
  const kept = [];
  const duplicateLog = [];

  for (const event of events) {
    const duplicateIndex = kept.findIndex((candidate) =>
      (event.eventKey && candidate.eventKey === event.eventKey) ||
      (candidate.category === event.category && jaccardSimilarity(candidate.title, event.title) >= 0.72)
    );

    if (duplicateIndex === -1) {
      kept.push(event);
      continue;
    }

    const existing = kept[duplicateIndex];
    const winner = scoreEvent(event) > scoreEvent(existing) ? event : existing;
    const loser = winner === event ? existing : event;
    kept[duplicateIndex] = mergeDuplicateEvents(winner, loser, config);
    duplicateLog.push({ kept: winner.title, removed: loser.title, reason: '同一事件聚类去重' });
  }

  return { events: kept, duplicateLog };
}

function runEditorialPipeline(input, config = PROJECT_CONFIG) {
  if (!input || typeof input !== 'object') throw new Error('输入文件必须是JSON对象。');
  if (collectStrings(input.thinking).join('\n').includes('*')) throw new Error('商业思考内容包含星号。');
  const window = getCoverageWindow(input.briefingDate, config);
  const accepted = [];
  const rejected = [];

  for (const candidate of input.candidates || []) {
    const errors = validateEvent(candidate, window, config);
    if (errors.length > 0) {
      rejected.push({ title: candidate && candidate.title ? candidate.title : '未命名候选', reasons: errors });
      continue;
    }
    accepted.push({
      ...candidate,
      sources: candidate.sources.map((source) => ({ ...source, url: canonicalizeUrl(source.url) })),
      fingerprint: createEventFingerprint(candidate),
      internalImportanceScore: scoreEvent(candidate)
    });
  }

  const deduplicated = deduplicateEvents(accepted, config);
  const categoryOrder = new Map(config.categories.map((category, index) => [category.id, index]));
  deduplicated.events.sort((left, right) => {
    const categoryDifference = categoryOrder.get(left.category) - categoryOrder.get(right.category);
    if (categoryDifference !== 0) return categoryDifference;
    if (right.internalImportanceScore !== left.internalImportanceScore) {
      return right.internalImportanceScore - left.internalImportanceScore;
    }
    return new Date(right.publishedAt) - new Date(left.publishedAt);
  });

  return {
    briefingDate: input.briefingDate,
    window,
    events: deduplicated.events,
    thinking: input.thinking || null,
    audit: {
      candidateCount: (input.candidates || []).length,
      acceptedBeforeDedup: accepted.length,
      eventCount: deduplicated.events.length,
      rejected,
      duplicates: deduplicated.duplicateLog
    }
  };
}

module.exports = {
  canonicalizeTitle,
  canonicalizeUrl,
  createEventFingerprint,
  deduplicateEvents,
  formatBeijingDateTime,
  getCoverageWindow,
  jaccardSimilarity,
  runEditorialPipeline,
  scoreEvent,
  validateEvent
};
