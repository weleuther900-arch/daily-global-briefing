'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PROJECT_CONFIG } = require('./config.cjs');
const { collectSources, writeJsonAtomic } = require('./discovery.cjs');
const { enrichDiscoveryItems } = require('./detail.cjs');
const { filterPreviouslySent, prepareModelCandidates } = require('./routing.cjs');
const { generateAndReview } = require('./openai.cjs');
const { runEditorialPipeline } = require('./pipeline.cjs');
const { renderHtml, renderPlainText } = require('./render.cjs');
const { buildMimeMessage, sendWithRetry } = require('./mime.cjs');
const { generateBusinessCase, renderBusinessCase, renderBusinessCaseText } = require('./case.cjs');
const { acquireLock, readJson, recordRun, releaseLock, updateSentState } = require('./state.cjs');

function projectPath(root, value) {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('运行路径必须位于项目目录内。');
  return resolved;
}

function beijingDate(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function trimDiscoveryForWindow(discovery, window, undatedLimitPerSource = 30) {
  return {
    ...discovery,
    sources: discovery.sources.map((source) => {
      let undated = 0;
      const items = (source.items || []).filter((item) => {
        if (!item.publishedAt) return undated++ < undatedLimitPerSource;
        const timestamp = new Date(item.publishedAt);
        return timestamp >= window.start && timestamp < window.end;
      });
      return { ...source, itemCount: items.length, items };
    })
  };
}

function writeFailure(outputDirectory, runId, phase, error, context = {}) {
  const failure = { runId, status: 'failed', phase, failedAt: new Date().toISOString(), message: error.message, context };
  const target = path.join(outputDirectory, `failure-${runId}.json`);
  writeJsonAtomic(target, failure);
  fs.writeFileSync(path.join(outputDirectory, `failure-${runId}.txt`), `全球晨报运行故障\n运行编号：${runId}\n阶段：${phase}\n原因：${error.message}\n`, 'utf8');
  return target;
}

function assertPublishableEditorialResult(result) {
  if (Array.isArray(result && result.events) && result.events.length > 0) return result;
  const rejectedCount = Array.isArray(result && result.audit && result.audit.rejected) ? result.audit.rejected.length : 0;
  throw new Error(`确定性编辑校验未留下可投递内容（拒绝${rejectedCount}条）。`);
}

function summarizeModelUsage(costs = []) {
  const byModel = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let cny = 0;
  for (const cost of costs) {
    const model = String(cost.model || 'unknown');
    const value = byModel[model] || { calls: 0, inputTokens: 0, outputTokens: 0, cny: 0 };
    value.calls += 1;
    value.inputTokens += Number(cost.inputTokens || 0);
    value.outputTokens += Number(cost.outputTokens || 0);
    value.cny += Number(cost.cny || 0);
    byModel[model] = value;
    inputTokens += Number(cost.inputTokens || 0);
    outputTokens += Number(cost.outputTokens || 0);
    cny += Number(cost.cny || 0);
  }
  return { calls: costs.length, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cny, byModel };
}

async function runDaily(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const date = options.date || beijingDate();
  const mode = options.mode || 'final';
  const scanHour = String(new Date().getUTCHours()).padStart(2, '0');
  const runId = options.runId || `${date}-${mode === 'scan' ? `scan-${scanHour}` : mode}`;
  const outputDirectory = projectPath(root, options.outputDirectory || 'output');
  const runtimeDirectory = projectPath(root, '.runtime');
  const stateDirectory = projectPath(root, 'state');
  const lockPath = path.join(runtimeDirectory, 'daily.lock');
  fs.mkdirSync(outputDirectory, { recursive: true });
  acquireLock(lockPath, { runId });
  let phase = 'start';
  try {
    const prior = readJson(path.join(stateDirectory, 'runs.json'), { runs: [] }).runs.find((item) => item.runId === runId && item.status === 'complete' && item.sent === true);
    if (prior) return { ...prior, idempotentSkip: true };

    if (mode === 'case') {
      phase = 'weekly-case';
      return await runWeeklyCase({ root, outputDirectory, stateDirectory, date, runId, send: options.send === true });
    }
    if (options.fixturePath) {
      phase = 'fixture-build';
      const fixture = JSON.parse(fs.readFileSync(projectPath(root, options.fixturePath), 'utf8'));
      const result = runEditorialPipeline({ ...fixture, briefingDate: date });
      return finalizeArtifacts(result, { root, outputDirectory, runId, date, review: { passed: true, fixture: true }, send: false });
    }

    phase = 'discovery';
    const registry = JSON.parse(fs.readFileSync(projectPath(root, 'config/sources.v1.json'), 'utf8'));
    const discovery = await collectSources(registry, { cacheDirectory: projectPath(root, '.cache/discovery'), concurrency: 5 });
    writeJsonAtomic(path.join(outputDirectory, `discovery-${runId}.json`), discovery);
    const impaired = discovery.coverageGroups.filter((group) => group.status === 'impaired');
    if (impaired.length) throw new Error(`来源覆盖不足：${impaired.map((group) => group.name).join('、')}。`);
    if (options.mode === 'scan') {
      const result = { runId, status: 'scan-complete', sourceCount: discovery.sourceCount, itemCount: discovery.itemCount, completedAt: new Date().toISOString() };
      recordRun(path.join(stateDirectory, 'runs.json'), result);
      return result;
    }

    phase = 'details';
    const { getCoverageWindow } = require('./pipeline.cjs');
    const trimmed = trimDiscoveryForWindow(discovery, getCoverageWindow(date));
    const details = await enrichDiscoveryItems(trimmed, registry, { cacheDirectory: projectPath(root, '.cache/details'), concurrency: 5 });

    phase = 'candidate-routing';
    const sentStatePath = path.join(stateDirectory, 'sent-events.json');
    const candidates = filterPreviouslySent(prepareModelCandidates(details, date), readJson(sentStatePath, { events: [] }));
    if (candidates.candidateCount === 0) throw new Error('本期没有通过质量门槛的候选内容，停止生成。');
    if (options.validateOnly === true) {
      const status = { runId, status: 'validation-complete', date, candidateCount: candidates.candidateCount, rejectedCount: candidates.rejectedCount, sent: false, completedAt: new Date().toISOString() };
      recordRun(path.join(stateDirectory, 'runs.json'), status);
      return status;
    }

    phase = 'generation-and-review';
    const generated = await generateAndReview(candidates, {
      ledgerPath: path.join(stateDirectory, 'cost-ledger.json'),
      monthlyBudgetCny: Number(process.env.MONTHLY_AI_BUDGET_CNY || 10),
      dailyTokenBudget: Number(process.env.DAILY_AI_TOKEN_BUDGET || 150000),
      usdCnyRate: Number(process.env.USD_CNY_RATE || 7.2)
    });
    writeJsonAtomic(path.join(outputDirectory, `review-${runId}.json`), generated.review);

    phase = 'editorial-validation';
    const result = runEditorialPipeline(generated.briefing);
    // 单条质量问题只应剔除该条内容；只要仍有合格事件，就继续生成晨报。
    // 先落盘审计信息，使全部拒绝时也能在私有运行产物中查看原因。
    const modelUsage = summarizeModelUsage(generated.costs);
    writeJsonAtomic(path.join(outputDirectory, `briefing-${date}.audit.json`), { ...result.audit, review: generated.review, modelUsage });
    assertPublishableEditorialResult(result);

    phase = 'artifact-finalization';
    const finalized = await finalizeArtifacts(result, { root, outputDirectory, runId, date, review: generated.review, modelUsage, send: options.send === true });
    if (finalized.sent) updateSentState(sentStatePath, result.events);
    return finalized;
  } catch (error) {
    const failurePath = writeFailure(outputDirectory, runId, phase, error);
    // 用户要求运行故障仅保留在私有运行记录中，不发送故障邮件。
    recordRun(path.join(stateDirectory, 'runs.json'), { runId, status: 'failed', phase, failurePath, failureNotified: false, completedAt: new Date().toISOString() });
    throw error;
  } finally {
    purgeDetailCache(projectPath(root, '.cache/details'));
    releaseLock(lockPath);
  }
}

async function runWeeklyCase(options) {
  const registry = JSON.parse(fs.readFileSync(path.join(options.root, 'config/sources.v1.json'), 'utf8'));
  const sentState = readJson(path.join(options.stateDirectory, 'sent-events.json'), { events: [] });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const seeds = (sentState.events || []).filter((event) => new Date(event.sentAt).getTime() >= cutoff).slice(0, 8);
  if (seeds.length === 0) throw new Error('过去七天没有可用于商业案例的已发送事件。');
  const bySource = new Map();
  for (const seed of seeds) {
    for (const url of seed.urls || []) {
      let hostname;
      try { hostname = new URL(url).hostname.toLowerCase(); } catch { continue; }
      const source = registry.sources.find((item) => item.discovery.allowedHosts.includes(hostname));
      if (!source) continue;
      if (!bySource.has(source.id)) bySource.set(source.id, { sourceId: source.id, sourceName: source.name, status: 'healthy', items: [] });
      bySource.get(source.id).items.push({
        sourceId: source.id, sourceName: source.name, sourceTier: source.tier, sourceKind: source.kind, topics: source.topics,
        title: seed.title, url, publishedAt: seed.sentAt,
        fingerprint: crypto.createHash('sha256').update(`${source.id}|${url}`).digest('hex').slice(0, 20), needsDetailFetch: true
      });
    }
  }
  const details = await enrichDiscoveryItems({ sources: [...bySource.values()] }, registry, { cacheDirectory: path.join(options.root, '.cache/details'), concurrency: 4 });
  const materials = details.items.filter((item) => item.detailStatus === 'ready' && item.access === 'open').map((item) => ({
    title: item.title, publishedAt: item.publishedAt, text: item.text.slice(0, 4000),
    sources: [{ organization: item.sourceName, title: item.title, url: item.url }]
  })).slice(0, 4);
  if (materials.length === 0) throw new Error('过去七天的案例候选原文均无法公开读取。');
  const generated = await generateBusinessCase(materials, {
    ledgerPath: path.join(options.stateDirectory, 'cost-ledger.json'),
    monthlyBudgetCny: Number(process.env.MONTHLY_AI_BUDGET_CNY || 10),
    dailyTokenBudget: Number(process.env.DAILY_AI_TOKEN_BUDGET || 150000),
    usdCnyRate: Number(process.env.USD_CNY_RATE || 7.2)
  });
  const html = renderBusinessCase(generated.content, options.date);
  const text = renderBusinessCaseText(generated.content, options.date);
  const subject = `[商业案例] ${generated.content.title}`;
  const mime = buildMimeMessage({ date: options.date, subject, senderName: PROJECT_CONFIG.senderName, from: PROJECT_CONFIG.senderAddress, to: PROJECT_CONFIG.recipientAddress, html, text });
  const base = `business-case-${options.date}`;
  fs.writeFileSync(path.join(options.outputDirectory, `${base}.html`), html, 'utf8');
  fs.writeFileSync(path.join(options.outputDirectory, `${base}.txt`), text, 'utf8');
  fs.writeFileSync(path.join(options.outputDirectory, `${base}.eml`), mime, 'utf8');
  writeJsonAtomic(path.join(options.outputDirectory, `${base}.audit.json`), { review: generated.review, sourceCount: generated.content.sources.length, modelUsage: summarizeModelUsage(generated.costs) });
  let sent = false;
  if (options.send) { await sendWithRetry(mime, { enabled: true }); sent = true; }
  const status = { runId: options.runId, status: 'complete', kind: 'business-case', date: options.date, sent, completedAt: new Date().toISOString() };
  recordRun(path.join(options.stateDirectory, 'runs.json'), status);
  return status;
}

function purgeDetailCache(cacheDirectory) {
  try {
    for (const entry of fs.readdirSync(cacheDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) fs.unlinkSync(path.join(cacheDirectory, entry.name));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function finalizeArtifacts(result, options) {
  const base = `briefing-${options.date}`;
  const html = renderHtml(result);
  const text = renderPlainText(result);
  const subject = `[全球晨报] ${options.date}`;
  const mime = buildMimeMessage({ date: options.date, subject, senderName: PROJECT_CONFIG.senderName, from: PROJECT_CONFIG.senderAddress, to: PROJECT_CONFIG.recipientAddress, html, text });
  fs.writeFileSync(path.join(options.outputDirectory, `${base}.html`), html, 'utf8');
  fs.writeFileSync(path.join(options.outputDirectory, `${base}.txt`), text, 'utf8');
  fs.writeFileSync(path.join(options.outputDirectory, `${base}.eml`), mime, 'utf8');
  writeJsonAtomic(path.join(options.outputDirectory, `${base}.selected.json`), { briefingDate: result.briefingDate, coverageStart: result.window.start.toISOString(), coverageEnd: result.window.end.toISOString(), events: result.events });
  writeJsonAtomic(path.join(options.outputDirectory, `${base}.audit.json`), { ...result.audit, review: options.review, modelUsage: options.modelUsage });
  let sent = false;
  if (options.send) {
    await sendWithRetry(mime, { enabled: true });
    sent = true;
  }
  const status = { runId: options.runId, status: 'complete', date: options.date, eventCount: result.events.length, sent, completedAt: new Date().toISOString() };
  recordRun(path.join(options.root, 'state/runs.json'), status);
  return status;
}

module.exports = { assertPublishableEditorialResult, beijingDate, finalizeArtifacts, projectPath, purgeDetailCache, runDaily, runWeeklyCase, summarizeModelUsage, trimDiscoveryForWindow, writeFailure };
