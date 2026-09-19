'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditGeneratedUrls, budgetCost, callStructured, candidateSubsetForEvent, compactCandidateResultForGeneration, compactCandidateResultForReview, compactGeneratedEventForReview, deepSeekFormatInstruction, generateAndReview, generatorPrompts, isClearlyBenignReviewIssue, normalizeGeneratedEvent, recoverTruncatedBriefing, removeEvidenceBlockedEvents, reviewSchema, reviewerConfig, reviewerPrompts, selectModelCandidates, splitBatches } = require('../src/openai.cjs');
const { runEditorialPipeline } = require('../src/pipeline.cjs');
const { renderPlainText } = require('../src/render.cjs');

const offPeakNow = new Date('2026-08-26T15:15:00Z'); // 北京时间23:15
const narrative = {
  plainLanguage: '用大白话解释这件事改变了哪个环节。',
  impact: '说明影响对象和经营变量。',
  judgmentBoundary: '说明当前不能确认的结论。'
};

test('未配置密钥时模型调用保持关闭', async () => {
  await assert.rejects(() => callStructured({ provider: 'openai', apiKey: '', systemPrompt: 's', userPrompt: 'u', schemaName: 'x', schema: { type: 'object' } }), /模型调用保持关闭/);
});

test('结构化调用使用Responses API、关闭存储并解析输出', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ id: 'resp_test', output: [{ content: [{ type: 'output_text', text: '{"passed":true}' }] }], usage: { input_tokens: 10, output_tokens: 5 } }) };
  };
  const result = await callStructured({ provider: 'openai', apiKey: 'test', fetchImpl, now: offPeakNow, model: 'gpt-5-mini', systemPrompt: '系统', userPrompt: '用户', schemaName: 'test', schema: { type: 'object', additionalProperties: false, required: ['passed'], properties: { passed: { type: 'boolean' } } }, maxOutputTokens: 20 });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.strict, true);
  assert.deepEqual(result.parsed, { passed: true });
});

test('DeepSeek生成调用使用JSON模式并关闭思考模式', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ id: 'ds_test', choices: [{ message: { content: '{"passed":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  };
  const result = await callStructured({ provider: 'deepseek', apiKey: 'test', fetchImpl, now: offPeakNow, model: 'deepseek-v4-flash', systemPrompt: '系统', userPrompt: '用户', schemaName: 'test', schema: { type: 'object' }, maxOutputTokens: 20 });
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.match(request.body.messages[0].content, /JSON Schema/);
  assert.deepEqual(result.parsed, { passed: true });
});

test('窗口外模型调用不会连接服务商', async () => {
  let requested = false;
  await assert.rejects(
    () => callStructured({
      provider: 'deepseek', apiKey: 'test', now: new Date('2026-08-27T00:31:00Z'),
      fetchImpl: async () => { requested = true; throw new Error('不应连接'); },
      systemPrompt: '系统', userPrompt: '用户', schemaName: 'test', schema: { type: 'object' }
    }),
    (error) => error.code === 'MODEL_WINDOW_CLOSED'
  );
  assert.equal(requested, false);
});

test('生成来源按候选URL继承已验证的公开访问元数据', () => {
  const event = normalizeGeneratedEvent({
    sources: [{ organization: '机构', title: '中文标题', url: 'https://example.com/open', access: 'paid', tier: 'C', isPrimary: false }]
  }, {
    candidates: [{ category: 'ai', sources: [{ organization: '机构', title: 'Original title', url: 'https://example.com/open', access: 'open', tier: 'S', isPrimary: true }] }]
  });
  assert.deepEqual(event.sources, [{ organization: '机构', title: '中文标题', url: 'https://example.com/open', access: 'open', tier: 'S', isPrimary: true }]);
});

test('DeepSeek返回损坏JSON时只重试一次并要求完整重写', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    const content = requests.length === 1 ? '{"passed":' : '{"passed":true}';
    return { ok: true, status: 200, json: async () => ({ id: `ds_retry_${requests.length}`, choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  };
  const result = await callStructured({ provider: 'deepseek', apiKey: 'test', fetchImpl, now: offPeakNow, model: 'deepseek-v4-flash', systemPrompt: '系统', userPrompt: '用户', schemaName: 'test', schema: { type: 'object' }, maxOutputTokens: 20 });
  assert.deepEqual(result.parsed, { passed: true });
  assert.equal(requests.length, 2);
  assert.match(requests[1].body.messages[0].content, /重新从头输出/);
});

test('DeepSeek截断晨报JSON时只恢复已经完整闭合的事件', () => {
  const complete = JSON.stringify({ eventKey: 'a', title: '完整事件', sources: [] });
  const output = `{"briefingDate":"2026-08-29","candidates":[${complete},{"eventKey":"未完成`;
  assert.deepEqual(recoverTruncatedBriefing(output), {
    briefingDate: '2026-08-29',
    candidates: [{ eventKey: 'a', title: '完整事件', sources: [] }],
    thinking: null
  });
});

test('截断的真实晨报输出仍可经过审校、编辑校验并进入邮件正文', async () => {
  const source = {
    organization: '测试机构', title: '正式更新', url: 'https://example.com/release', tier: 'S', access: 'open', isPrimary: true,
    kind: 'official', publishedAt: '2026-08-28T22:30:00.000Z'
  };
  const event = {
    eventKey: 'release-1', category: 'ai', title: '测试平台发布更新', conclusion: '更新改变了企业接入方式。',
    ...narrative,
    publishedAt: source.publishedAt, editorialDecision: 'include', evidenceStatus: 'confirmed', evidenceNote: null,
    includeReason: 'material-impact', exclusionFlags: [], tags: ['测试'],
    importance: { scope: 1, magnitude: 1, duration: 1, relevance: 2, evidence: 2 },
    sections: [{ title: '事实', paragraphs: ['测试机构发布了更新。'] }, { title: '影响', paragraphs: ['分析上，企业需评估迁移成本。'] }],
    concepts: [], formula: null, dataTable: null, watch: [{ item: '采用情况', reason: '决定影响范围。' }],
    sources: [{ organization: source.organization, title: source.title, url: source.url, tier: source.tier, access: source.access, isPrimary: true }],
    criticalFacts: [{ claim: '测试机构发布了更新。', sourceUrls: [source.url] }]
  };
  const requests = [];
  const fetchImpl = async (_url, request) => {
    requests.push(JSON.parse(request.body));
    const content = requests.length === 1
      ? `{"briefingDate":"2026-08-29","candidates":[${JSON.stringify(event)},{"eventKey":"truncated`
      : '{"passed":true,"issues":[]}';
    return { ok: true, status: 200, json: async () => ({ id: `response-${requests.length}`, choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) };
  };
  const generated = await generateAndReview({ briefingDate: '2026-08-29', candidates: [{ ...event, sources: [source] }] }, {
    apiKey: 'test', fetchImpl, now: offPeakNow, maxCandidates: 1, batchSize: 1
  });
  const result = runEditorialPipeline(generated.briefing);
  assert.equal(requests.length, 2);
  assert.equal(generated.briefing.candidates.length, 1);
  assert.equal(result.events.length, 1);
  assert.match(renderPlainText(result), /测试平台发布更新/);
});

test('DeepSeek复核默认使用V4 Pro', () => {
  const previousProvider = process.env.BRIEFING_REVIEWER_PROVIDER;
  const previousModel = process.env.DEEPSEEK_REVIEW_MODEL;
  process.env.BRIEFING_REVIEWER_PROVIDER = 'deepseek';
  delete process.env.DEEPSEEK_REVIEW_MODEL;
  assert.deepEqual(reviewerConfig(), { provider: 'deepseek', model: 'deepseek-v4-pro' });
  if (previousProvider === undefined) delete process.env.BRIEFING_REVIEWER_PROVIDER;
  else process.env.BRIEFING_REVIEWER_PROVIDER = previousProvider;
  if (previousModel === undefined) delete process.env.DEEPSEEK_REVIEW_MODEL;
  else process.env.DEEPSEEK_REVIEW_MODEL = previousModel;
});

test('预算成本按安全倍数预留', () => {
  assert.equal(budgetCost({ cny: 0.6 }, { budgetCostMultiplier: 2 }).budgetCny, 1.2);
});

test('模型候选按来源等级和相关度收敛，并分批生成', () => {
  const input = {
    briefingDate: '2026-08-23',
    candidates: [
      { title: '普通候选', relevanceScore: 2, publishedAt: '2026-08-22T01:00:00Z', sources: [{ tier: 'B', kind: 'media' }] },
      { title: '官方候选', relevanceScore: 4, publishedAt: '2026-08-22T02:00:00Z', sources: [{ tier: 'S', kind: 'official' }] },
      { title: '次要候选', relevanceScore: 3, publishedAt: '2026-08-22T03:00:00Z', sources: [{ tier: 'A', kind: 'official' }] }
    ]
  };
  const selected = selectModelCandidates(input, 2);
  assert.deepEqual(selected.candidates.map((item) => item.title), ['官方候选', '次要候选']);
  assert.equal(selected.deferredCandidateCount, 1);
  assert.equal(splitBatches(selected.candidates, 1).length, 2);
});

test('默认每栏最多保留三条候选，而非由强势栏目占满', () => {
  const categories = ['ai', 'ai', 'digital-economy', 'china-economy-policy', 'global-economy-politics', 'open-source-tech'];
  const candidates = categories.map((category, index) => ({
    category, title: `候选${index}`, relevanceScore: 10 - index, publishedAt: `2026-08-2${index}T00:00:00Z`, sources: [{ tier: 'A', kind: 'official' }]
  }));
  const selected = selectModelCandidates({ candidates });
  assert.equal(selected.candidateCount, 6);
  assert.equal(selected.deferredCandidateCount, 0);
  assert.deepEqual(new Set(selected.candidates.map((candidate) => candidate.category)), new Set(['ai', 'digital-economy', 'china-economy-policy', 'global-economy-politics', 'open-source-tech']));
});

test('默认逐条生成，损坏的一条不会丢弃另一条合格事件', async () => {
  const source = { organization: '测试机构', title: '原始材料', url: 'https://example.com/source', tier: 'S', access: 'open', isPrimary: true, kind: 'official', publishedAt: '2026-08-28T22:00:00.000Z' };
  const event = {
    eventKey: 'valid-event', category: 'ai', title: '合格事件', conclusion: '测试结论。', publishedAt: source.publishedAt,
    ...narrative,
    editorialDecision: 'include', evidenceStatus: 'confirmed', evidenceNote: null, includeReason: 'material-impact', exclusionFlags: [], tags: [],
    importance: { scope: 1, magnitude: 1, duration: 1, relevance: 1, evidence: 1 }, sections: [{ title: '事实', paragraphs: ['已发布。'] }, { title: '影响', paragraphs: ['分析上，有待观察。'] }],
    concepts: [], formula: null, dataTable: null, watch: [], sources: [{ organization: source.organization, title: source.title, url: source.url, tier: source.tier, access: source.access, isPrimary: true }], criticalFacts: [{ claim: '已发布。', sourceUrls: [source.url] }]
  };
  const requests = [];
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    requests.push(body);
    if (body.model === 'deepseek-v4-pro') return { ok: true, status: 200, json: async () => ({ id: 'review', choices: [{ message: { content: '{"passed":true,"issues":[]}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    const candidateTitle = JSON.parse(body.messages[1].content.match(/<不可信候选材料>\n([\s\S]*)\n<\/不可信候选材料>/)[1]).candidates[0].title;
    const content = candidateTitle === '损坏候选' ? '{"briefingDate":"2026-08-29","candidates":[' : JSON.stringify({ briefingDate: '2026-08-29', candidates: [event], thinking: null });
    return { ok: true, status: 200, json: async () => ({ id: `generation-${requests.length}`, choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  const generated = await generateAndReview({ briefingDate: '2026-08-29', candidates: [{ title: '合格候选', relevanceScore: 2, publishedAt: source.publishedAt, sources: [source] }, { title: '损坏候选', relevanceScore: 1, publishedAt: source.publishedAt, sources: [source] }] }, { apiKey: 'test', fetchImpl, now: offPeakNow });
  assert.equal(generated.briefing.candidates.length, 1);
  assert.deepEqual(generated.review.skippedGeneration, ['损坏候选']);
  assert.equal(requests.filter((body) => body.model === 'deepseek-v4-flash').length, 3);
});

test('全部生成内容被证据复核剔除时返回受控停止码', async () => {
  const source = { organization: '测试机构', title: '原始材料', url: 'https://example.com/source', tier: 'S', access: 'open', isPrimary: true, kind: 'official', publishedAt: '2026-08-28T22:00:00.000Z' };
  const event = { eventKey: 'rejected-event', category: 'ai', title: '待剔除事件', conclusion: '测试结论。', ...narrative, publishedAt: source.publishedAt, editorialDecision: 'include', evidenceStatus: 'confirmed', evidenceNote: null, includeReason: 'material-impact', exclusionFlags: [], tags: [], importance: { scope: 1, magnitude: 1, duration: 1, relevance: 1, evidence: 1 }, sections: [{ title: '事实', paragraphs: ['已发布。'] }, { title: '影响', paragraphs: ['分析上，有待观察。'] }], concepts: [], formula: null, dataTable: null, watch: [], sources: [{ organization: source.organization, title: source.title, url: source.url, tier: source.tier, access: source.access, isPrimary: true }], criticalFacts: [{ claim: '已发布。', sourceUrls: [source.url] }] };
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    const content = body.model === 'deepseek-v4-pro'
      ? '{"passed":false,"issues":[{"eventIndex":0,"severity":"blocking","field":"事实","problem":"来源不支持该陈述。"}]}'
      : JSON.stringify({ briefingDate: '2026-08-29', candidates: [event], thinking: null });
    return { ok: true, status: 200, json: async () => ({ id: 'test', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  await assert.rejects(() => generateAndReview({ briefingDate: '2026-08-29', candidates: [{ title: '候选', relevanceScore: 1, publishedAt: source.publishedAt, sources: [source] }] }, { apiKey: 'test', fetchImpl, now: offPeakNow }), (error) => error.code === 'NO_PUBLISHABLE_CONTENT' && error.context.withheldReasons[0].issues[0].problem === '来源不支持该陈述。');
});

test('证据复核指出问题后只受限改写一次，并重新复核后保留合格事件', async () => {
  const source = { organization: '测试机构', title: '原始材料', url: 'https://example.com/source', tier: 'S', access: 'open', isPrimary: true, kind: 'official', publishedAt: '2026-08-28T22:00:00.000Z' };
  const draft = { eventKey: 'repair-event', category: 'ai', title: '待修订事件', conclusion: '来源未说明的确定性结论。', ...narrative, publishedAt: source.publishedAt, editorialDecision: 'include', evidenceStatus: 'confirmed', evidenceNote: null, includeReason: 'material-impact', exclusionFlags: [], tags: [], importance: { scope: 1, magnitude: 1, duration: 1, relevance: 1, evidence: 1 }, sections: [{ title: '事实', paragraphs: ['已发布。'] }, { title: '影响', paragraphs: ['分析上，有待观察。'] }], concepts: [], formula: null, dataTable: null, watch: [], sources: [{ organization: source.organization, title: source.title, url: source.url, tier: source.tier, access: source.access, isPrimary: true }], criticalFacts: [{ claim: '已发布。', sourceUrls: [source.url] }] };
  const repaired = { ...draft, conclusion: '来源确认已发布。' };
  let flashCalls = 0;
  let reviewCalls = 0;
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    if (body.model === 'deepseek-v4-pro') {
      reviewCalls += 1;
      const content = reviewCalls === 1
        ? '{"passed":false,"issues":[{"eventIndex":0,"severity":"blocking","field":"conclusion","problem":"来源不支持该结论。"}]}'
        : '{"passed":true,"issues":[]}';
      return { ok: true, status: 200, json: async () => ({ id: `review-${reviewCalls}`, choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    }
    flashCalls += 1;
    const event = flashCalls === 1 ? draft : repaired;
    return { ok: true, status: 200, json: async () => ({ id: `flash-${flashCalls}`, choices: [{ message: { content: JSON.stringify({ briefingDate: '2026-08-29', candidates: [event], thinking: null }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  const result = await generateAndReview({ briefingDate: '2026-08-29', candidates: [{ category: 'ai', title: '候选', relevanceScore: 1, publishedAt: source.publishedAt, sources: [source] }] }, { apiKey: 'test', fetchImpl, now: offPeakNow });
  assert.equal(result.briefing.candidates[0].conclusion, repaired.conclusion);
  assert.deepEqual(result.review.repairedForEvidence, [0]);
  assert.equal(flashCalls, 2);
  assert.equal(reviewCalls, 2);
});

test('生成结构不合格时先受限改写，再进入独立复核', async () => {
  const source = { organization: '测试机构', title: '原始材料', url: 'https://example.com/source', tier: 'S', access: 'open', isPrimary: true, kind: 'official', publishedAt: '2026-08-28T22:00:00.000Z' };
  const invalid = { eventKey: 'invalid-event', category: 'politics', title: '待修订事件', conclusion: '来源确认已发布。', ...narrative, publishedAt: source.publishedAt, editorialDecision: 'include', evidenceStatus: 'confirmed', evidenceNote: null, includeReason: 'material-impact', exclusionFlags: [], tags: [], importance: { scope: 1, magnitude: 1, duration: 1, relevance: 1, evidence: 1 }, sections: [{ title: '', paragraphs: [''] }, { title: '', paragraphs: [''] }], concepts: [], formula: null, dataTable: null, watch: [], sources: [{ organization: source.organization, title: source.title, url: source.url, tier: source.tier, access: source.access, isPrimary: true }], criticalFacts: [{ claim: '', sourceUrls: [] }] };
  const repaired = { ...invalid, category: 'ai', sections: [{ title: '事实', paragraphs: ['已发布。'] }, { title: '影响', paragraphs: ['分析上，有待观察。'] }], criticalFacts: [{ claim: '已发布。', sourceUrls: [source.url] }] };
  let flashCalls = 0;
  let reviewCalls = 0;
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    if (body.model === 'deepseek-v4-pro') {
      reviewCalls += 1;
      const content = reviewCalls === 1
        ? '{"passed":false,"issues":[{"eventIndex":0,"severity":"blocking","field":"conclusion","problem":"需要收紧为来源已确认的表述。"}]}'
        : '{"passed":true,"issues":[]}';
      return { ok: true, status: 200, json: async () => ({ id: 'review', choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    }
    flashCalls += 1;
    const event = flashCalls === 1 ? invalid : repaired;
    return { ok: true, status: 200, json: async () => ({ id: `flash-${flashCalls}`, choices: [{ message: { content: JSON.stringify({ briefingDate: '2026-08-29', candidates: [event], thinking: null }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  const result = await generateAndReview({ briefingDate: '2026-08-29', candidates: [{ category: 'ai', title: '候选', relevanceScore: 1, publishedAt: source.publishedAt, sources: [source] }] }, { apiKey: 'test', fetchImpl, now: offPeakNow });
  assert.equal(result.briefing.candidates[0].category, 'ai');
  assert.equal(result.briefing.candidates[0].sections[0].title, '事实');
  assert.deepEqual(result.review.repairedForEvidence, [0]);
  assert.equal(flashCalls, 3);
  assert.equal(reviewCalls, 2);
});

test('逐条复核证据摘录受长度上限约束', () => {
  const compact = compactCandidateResultForReview({ briefingDate: '2026-08-29', candidates: [{
    category: 'ai', title: '候选', publishedAt: '2026-08-28T22:00:00Z', sources: [{ url: 'https://example.com/a', excerpt: '甲'.repeat(2000) }]
  }] });
  assert.equal(compact.candidates[0].sources[0].excerpt.length, 2000);
});

test('生成阶段只携带精简来源摘录，避免重复发送完整网页', () => {
  const compact = compactCandidateResultForGeneration({ briefingDate: '2026-08-29', candidates: [{
    category: 'ai', title: '候选', publishedAt: '2026-08-28T22:00:00Z', internalNotes: '不应发送', sources: [{ url: 'https://example.com/a', excerpt: '甲'.repeat(2000), body: '不应发送' }]
  }] });
  assert.equal(compact.candidates.length, 1);
  assert.equal(compact.candidates[0].sources[0].excerpt.length, 2000);
  assert.equal(Object.hasOwn(compact.candidates[0], 'internalNotes'), false);
  assert.equal(Object.hasOwn(compact.candidates[0].sources[0], 'body'), false);
});

test('模型把可选列表返回为对象时，复核输入安全降级而不使任务崩溃', () => {
  const compact = compactGeneratedEventForReview({ title: '测试', watch: { item: '错误形态' }, sections: { title: '错误形态' }, concepts: null, formula: { notes: '错误形态' }, dataTable: { headings: '错误形态', rows: {} }, sources: null, criticalFacts: { claim: '错误形态' } });
  assert.deepEqual(compact.watch, []);
  assert.deepEqual(compact.sections, []);
  assert.deepEqual(compact.formula.notes, []);
  assert.deepEqual(compact.dataTable.headings, []);
  assert.deepEqual(compact.dataTable.rows, []);
  assert.deepEqual(compact.criticalFacts, []);
});

test('晨报与复核请求使用紧凑格式契约，不重复传递完整JSON Schema', () => {
  const schema = { properties: { discarded: { description: '不应出现在紧凑契约中' } } };
  const daily = deepSeekFormatInstruction('daily_briefing', schema);
  const review = deepSeekFormatInstruction('daily_briefing_event_review', schema);
  assert.match(daily, /thinking为null或含title、scenario、decisionQuestion、options、checks的对象/);
  assert.match(daily, /formula为null或含symbol、text、notes的对象/);
  assert.equal(daily.includes('不应出现在紧凑契约中'), false);
  assert.match(review, /eventIndex只能为0/);
  assert.match(deepSeekFormatInstruction('other', schema), /JSON Schema/);
});

test('复核仅剔除存在实质证据问题的事件，保留条件性分析', () => {
  const briefing = { candidates: [{ title: '保留' }, { title: '剔除' }] };
  const conditional = { eventIndex: 0, severity: 'blocking', problem: '“分析上，若需求上升则成本可能增加。”属于分析性内容。' };
  const unsupported = { eventIndex: 1, severity: 'blocking', problem: '该结论在来源中无依据。' };
  assert.equal(isClearlyBenignReviewIssue(conditional), true);
  assert.deepEqual(removeEvidenceBlockedEvents(briefing, [conditional, unsupported]), { briefing: { candidates: [{ title: '保留' }] }, removedIndexes: [1] });
});

test('逐条复核只携带该事件关联的原始候选', () => {
  const input = { candidates: [
    { title: '甲', sources: [{ url: 'https://example.com/a' }] },
    { title: '乙', sources: [{ url: 'https://example.com/b' }] }
  ] };
  const subset = candidateSubsetForEvent(input, { sources: [{ url: 'https://example.com/b' }] });
  assert.equal(subset.candidateCount, 1);
  assert.equal(subset.candidates[0].title, '乙');
});

test('逐条复核架构限制问题数量和篇幅', () => {
  const schema = reviewSchema();
  assert.equal(schema.properties.issues.maxItems, 3);
  assert.equal(schema.properties.issues.items.properties.eventIndex.maximum, 0);
  assert.equal(schema.properties.issues.items.properties.problem.maxLength, 260);
});

test('提示明确把网页内容当作不可信数据', () => {
  const prompts = generatorPrompts({ briefingDate: '2026-08-17', candidates: [] });
  assert.match(prompts.systemPrompt, /不可信资料/);
  assert.match(prompts.systemPrompt, /这取决于/);
  assert.match(prompts.systemPrompt, /最多包含一条候选/);
  assert.match(prompts.systemPrompt, /公式或数据表只有在来源直接提供且确有解释价值时才填写/);
  assert.match(prompts.systemPrompt, /category必须逐字复制输入候选的category/);
  assert.match(prompts.systemPrompt, /每个小节必须同时有非空标题和非空段落/);
  assert.match(prompts.systemPrompt, /claim不得为空/);
  assert.match(prompts.systemPrompt, /plainLanguage用非专业读者能理解的语言解释/);
  assert.match(prompts.systemPrompt, /impact说明影响谁、通过什么经营或产业变量传导/);
  assert.match(prompts.systemPrompt, /judgmentBoundary说明哪些结论目前不能确认/);
  assert.match(prompts.systemPrompt, /真正可在三分钟内作答的商业决策练习/);
  assert.match(generatorPrompts({ briefingDate: '2026-08-17', candidates: [] }, { includeThinking: false }).systemPrompt, /本批thinking必须为null/);
  assert.match(prompts.userPrompt, /<不可信候选材料>/);
});

test('复核允许英文来源标题的忠实中文翻译', () => {
  assert.match(reviewerPrompts({ candidates: [] }, { candidates: [] }).systemPrompt, /英文来源标题的忠实中文翻译是允许的/);
});

test('生成结果不能添加输入中不存在的来源链接', () => {
  const input = { candidates: [{ sources: [{ url: 'https://example.com/a', publishedAt: '2026-08-16T12:00:00Z' }] }] };
  const output = { candidates: [{ publishedAt: '2026-08-16T12:00:00Z', sources: [{ url: 'https://evil.example/a' }] }] };
  assert.equal(auditGeneratedUrls(input, output).length > 0, true);
});
