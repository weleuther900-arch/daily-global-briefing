'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { auditGeneratedUrls, budgetCost, callStructured, candidateSubsetForEvent, compactCandidateResultForReview, generateAndReview, generatorPrompts, isClearlyBenignReviewIssue, recoverTruncatedBriefing, removeEvidenceBlockedEvents, reviewSchema, reviewerConfig, selectModelCandidates, splitBatches } = require('../src/openai.cjs');
const { runEditorialPipeline } = require('../src/pipeline.cjs');
const { renderPlainText } = require('../src/render.cjs');

const offPeakNow = new Date('2026-08-26T15:15:00Z'); // 北京时间23:15

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

test('默认最多向模型提交两个候选，避免复核成本失控', () => {
  const candidates = Array.from({ length: 6 }, (_, index) => ({
    title: `候选${index}`, relevanceScore: index, publishedAt: `2026-08-2${index}T00:00:00Z`, sources: [{ tier: 'A', kind: 'official' }]
  }));
  assert.equal(selectModelCandidates({ candidates }).candidateCount, 2);
});

test('逐条复核证据摘录受长度上限约束', () => {
  const compact = compactCandidateResultForReview({ briefingDate: '2026-08-29', candidates: [{
    category: 'ai', title: '候选', publishedAt: '2026-08-28T22:00:00Z', sources: [{ url: 'https://example.com/a', excerpt: '甲'.repeat(2000) }]
  }] });
  assert.equal(compact.candidates[0].sources[0].excerpt.length, 900);
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
  assert.match(prompts.userPrompt, /<不可信候选材料>/);
});

test('生成结果不能添加输入中不存在的来源链接', () => {
  const input = { candidates: [{ sources: [{ url: 'https://example.com/a', publishedAt: '2026-08-16T12:00:00Z' }] }] };
  const output = { candidates: [{ publishedAt: '2026-08-16T12:00:00Z', sources: [{ url: 'https://evil.example/a' }] }] };
  assert.equal(auditGeneratedUrls(input, output).length > 0, true);
});
