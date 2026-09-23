'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PROJECT_CONFIG } = require('./config.cjs');
const { appendRunLog } = require('./run-log.cjs');
const { withinEditorialWindow } = require('./observation.cjs');
const { integrityIssues } = require('./case-review.cjs');
const { collectSources, writeJsonAtomic } = require('./discovery.cjs');
const { enrichDiscoveryItems } = require('./detail.cjs');
const { filterPreviouslySent, prepareModelCandidates } = require('./routing.cjs');
const { generateAndReview } = require('./openai.cjs');
const { runEditorialPipeline } = require('./pipeline.cjs');
const { renderHtml, renderPlainText } = require('./render.cjs');
const { buildMimeMessage, sendWithRetry } = require('./mime.cjs');
const { generateBusinessCase, renderBusinessCase, renderBusinessCaseText } = require('./case.cjs');
const { acquireLock, readJson, recordRun, releaseLock, updateSentState } = require('./state.cjs');
const { isModelInvocationAllowed, isMorningBriefingReady, isWeeklyCaseInvocationAllowed, weeklyCaseDate } = require('./model-window.cjs');

// 周日案例独立于当周晨报：素材池覆盖公司经营、开发者平台和开源生态，避免
// “本周日报恰好没有可刊内容”就没有商业案例。每次只选择其中一组来源，并用
// 历史记录轮换，案例可分析公司、行业或经营决策，而不是日报事件的长摘要。
const WEEKLY_CASE_FALLBACK_SOURCE_IDS = Object.freeze([
  'nvidia-investor-results',
  'microsoft-investor-results',
  'tsmc-investor-results',
  'nvidia-newsroom',
  'microsoft-official-blog',
  'openai-news',
  'anthropic-news',
  'deepmind-blog',
  'meta-ai-blog',
  'mistral-news',
  'xai-news',
  'qwen-blog',
  'github-changelog',
  'hugging-face-blog'
]);
const CASE_HISTORY_RETENTION_DAYS = 365;
const CASE_ENTITY_COOLDOWN_DAYS = 28;
const CASE_SOURCE_LIMIT = 16;
const CASE_ITEMS_PER_SOURCE_LIMIT = 6;
const CASE_MATERIAL_MINIMUM = 3;
const CONTROLLED_STOP_CODES = Object.freeze(['MODEL_OUTPUT_INVALID', 'NO_PUBLISHABLE_CONTENT', 'COVERAGE_INSUFFICIENT', 'MONTHLY_BUDGET_EXCEEDED', 'DAILY_TOKEN_BUDGET_EXCEEDED', 'CASE_REVIEW_BLOCKED']);

function projectPath(root, value) {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('运行路径必须位于项目目录内。');
  return resolved;
}

// 早期本地命令曾使用 briefing.sample.json；公开仓库现已统一为
// candidates.sample.json。保留这个窄兼容映射，避免一次样例验证把正式运行
// 误记为失败，同时不接受任意不存在路径。
function resolveFixturePath(root, fixturePath) {
  const requested = projectPath(root, fixturePath);
  if (fs.existsSync(requested)) return requested;
  if (String(fixturePath).replaceAll('\\', '/') === 'examples/briefing.sample.json') {
    const replacement = projectPath(root, 'examples/candidates.sample.json');
    if (fs.existsSync(replacement)) return replacement;
  }
  const error = new Error(`找不到样例文件：${fixturePath}。内置样例为 examples/candidates.sample.json。`);
  error.code = 'FIXTURE_NOT_FOUND';
  throw error;
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
        return withinEditorialWindow(item, window);
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
  const error = new Error(`确定性编辑校验未留下可投递内容（拒绝${rejectedCount}条）。`);
  error.code = 'NO_PUBLISHABLE_CONTENT';
  throw error;
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

function monthlyBudgetForRun(now = new Date(), environment = process.env) {
  const hardStopUntil = Date.parse(environment.AI_HARD_STOP_UNTIL || '');
  if (Number.isFinite(hardStopUntil) && now.getTime() < hardStopUntil) return 0;
  const budget = Number(environment.MONTHLY_AI_BUDGET_CNY || 10);
  return Number.isFinite(budget) && budget >= 0 ? budget : 10;
}

function hasSentRunForDate(runState, date) {
  return (runState.runs || []).some((item) => item.date === date && item.sent === true);
}

function getImpairedCoverageGroups(discovery) {
  return (discovery.coverageGroups || []).filter((group) => group.status === 'impaired');
}

function selectedEventsFromOutput(outputDirectory, now = new Date()) {
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  let entries = [];
  try {
    entries = fs.readdirSync(outputDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && /^briefing-\d{4}-\d{2}-\d{2}\.selected\.json$/.test(entry.name))
    .flatMap((entry) => {
      const selected = readJson(path.join(outputDirectory, entry.name), { events: [] });
      return (selected.events || []).map((event) => ({
        ...event,
        selectedAt: `${selected.briefingDate || entry.name.slice(9, 19)}T07:00:00+08:00`
      }));
    })
    .filter((event) => new Date(event.selectedAt).getTime() >= cutoff);
}

function weeklyCaseSeeds(sentState, outputDirectory, now = new Date()) {
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const sent = (sentState.events || [])
    .filter((event) => new Date(event.sentAt).getTime() >= cutoff)
    .map((event) => ({ ...event, selectedAt: event.sentAt }));
  const selected = selectedEventsFromOutput(outputDirectory, now).map((event) => ({
    ...event,
    urls: (event.sources || []).map((source) => source.url)
  }));
  const unique = new Map();
  for (const event of [...sent, ...selected]) {
    const key = event.fingerprint || `${event.title}|${(event.urls || []).join('|')}`;
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()]
    .filter((event) => new Date(event.selectedAt).getTime() >= cutoff)
    .sort((left, right) => new Date(right.selectedAt) - new Date(left.selectedAt))
    .slice(0, 8);
}

function weeklyCaseFallbackSourceIds(registry, history = { cases: [] }, now = new Date()) {
  const available = new Set((registry.sources || []).map((source) => source.id));
  const eligible = WEEKLY_CASE_FALLBACK_SOURCE_IDS.filter((sourceId) => available.has(sourceId));
  const cooldown = new Date(now.getTime() - CASE_ENTITY_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).getTime();
  const recentlyUsed = new Set((history.cases || [])
    .filter((entry) => new Date(entry.generatedAt || entry.date || 0).getTime() >= cooldown)
    .flatMap((entry) => entry.entityKeys || []));
  // 若近期没有足够多的不同实体，保留完整池，但仍会在材料层排除已用 URL；
  // 这样不会因历史记录过多让周日案例再次停刊。
  const fresh = eligible.filter((sourceId) => !recentlyUsed.has(caseEntityKey(sourceId)));
  const candidates = fresh.length >= CASE_MATERIAL_MINIMUM ? fresh : eligible;
  if (candidates.length <= CASE_SOURCE_LIMIT) return candidates;
  const weekIndex = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000));
  const offset = weekIndex % candidates.length;
  return [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(0, CASE_SOURCE_LIMIT);
}

function caseEntityKey(sourceId) {
  const id = String(sourceId || '').toLowerCase();
  if (id.startsWith('nvidia-')) return 'nvidia';
  if (id.startsWith('microsoft-')) return 'microsoft';
  if (id.startsWith('google-') || id.startsWith('deepmind-')) return 'google';
  if (id.startsWith('github-')) return 'github';
  if (id.startsWith('openai-')) return 'openai';
  if (id.startsWith('anthropic-')) return 'anthropic';
  if (id.startsWith('meta-')) return 'meta';
  if (id.startsWith('mistral-')) return 'mistral';
  if (id.startsWith('xai-')) return 'xai';
  if (id.startsWith('qwen-')) return 'qwen';
  if (id.startsWith('hugging-face-')) return 'hugging-face';
  if (id.startsWith('tsmc-')) return 'tsmc';
  return id;
}

function readCaseHistory(stateDirectory, now = new Date()) {
  const cutoff = now.getTime() - CASE_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const history = readJson(path.join(stateDirectory, 'business-case-history.json'), { cases: [] });
  return {
    cases: (history.cases || []).filter((entry) => new Date(entry.generatedAt || entry.date || 0).getTime() >= cutoff)
  };
}

function trimCaseDiscovery(discovery, perSourceLimit = CASE_ITEMS_PER_SOURCE_LIMIT) {
  return {
    ...discovery,
    sources: (discovery.sources || []).map((source) => ({
      ...source,
      items: [...(source.items || [])]
        .sort((left, right) => new Date(right.publishedAt || 0) - new Date(left.publishedAt || 0))
        .slice(0, perSourceLimit)
    }))
  };
}

function selectWeeklyCaseMaterialGroups(details, history, now = new Date()) {
  const earliest = now.getTime() - CASE_HISTORY_RETENTION_DAYS * 86400000;
  const cooldown = now.getTime() - CASE_ENTITY_COOLDOWN_DAYS * 86400000;
  const usedUrls = new Set((history.cases || []).flatMap(entry => entry.sourceUrls || []).map(url => url.replace(/\/$/, '')));
  const recentEntities = new Set((history.cases || []).filter(entry => Date.parse(entry.generatedAt || entry.date) >= cooldown).flatMap(entry => entry.entityKeys || []));
  const groups = new Map();
  const seen = new Set();
  for (const item of [...(details.items || [])].sort((a,b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))) {
    const timestamp = Date.parse(item.publishedAt);
    const entityKey = caseEntityKey(item.sourceId);
    const url = String(item.url || '').replace(/\/$/, '');
    if (item.detailStatus !== 'ready' || item.access !== 'open' || !Number.isFinite(timestamp) || timestamp < earliest || timestamp > now.getTime() || usedUrls.has(url) || seen.has(url) || recentEntities.has(entityKey) || typeof item.text !== 'string') continue;
    seen.add(url);
    const group = groups.get(entityKey) || [];
    if (group.length < 5) group.push({ title: item.title, publishedAt: item.publishedAt, text: item.text.slice(0,6000), entityKey, sourceIds: [item.sourceId], sources: [{ organization: item.sourceName, title: item.title, url: item.url }] });
    groups.set(entityKey, group);
  }
  // 一篇案例至少三份同一主体材料。不能把三家无关公司的单篇公告凑成案例。
  return [...groups.values()].filter(group => group.length >= CASE_MATERIAL_MINIMUM)
    .sort((a,b) => b.length - a.length || Date.parse(b[0].publishedAt) - Date.parse(a[0].publishedAt));
}

function selectWeeklyCaseMaterials(details, history, now = new Date()) {
  return selectWeeklyCaseMaterialGroups(details, history, now)[0] || [];
}

function updateCaseHistory(stateDirectory, caseContent, materials, now = new Date()) {
  const history = readCaseHistory(stateDirectory, now);
  const entry = {
    generatedAt: now.toISOString(),
    title: caseContent.title,
    entityKeys: [...new Set(materials.map((item) => item.entityKey))],
    sourceUrls: [...new Set(materials.flatMap((item) => item.sources.map((source) => source.url)))]
  };
  writeJsonAtomic(path.join(stateDirectory, 'business-case-history.json'), { cases: [...history.cases, entry] });
  return entry;
}

async function runDaily(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const now = options.now || new Date();
  const mode = options.mode || 'final';
  const date = options.date || (mode === 'case' ? weeklyCaseDate(now) : beijingDate(now));
  const scanHour = String(new Date().getUTCHours()).padStart(2, '0');
  const runId = options.runId || `${date}-${mode === 'scan' ? `scan-${scanHour}` : mode}`;
  const outputDirectory = projectPath(root, options.outputDirectory || 'output');
  const runtimeDirectory = projectPath(root, '.runtime');
  const stateDirectory = projectPath(root, 'state');
  const lockPath = path.join(runtimeDirectory, 'daily.lock');
  fs.mkdirSync(outputDirectory, { recursive: true });
  acquireLock(lockPath, { runId });
  let phase = 'start';
  const log = (event, extra = {}) => appendRunLog(root, { runId, mode, phase, event, ...extra });
  const finish = result => { log('run-complete', { status: result.status, date: result.date, sent: result.sent === true, eventCount: result.eventCount, candidateCount: result.candidateCount, idempotentSkip: result.idempotentSkip === true }); return result; };
  log('run-start', { date });
  try {
    const runStatePath = path.join(stateDirectory, 'runs.json');
    const runState = readJson(runStatePath, { runs: [] });
    const prior = runState.runs.find((item) => item.runId === runId && item.status === 'complete' && item.sent === true);
    if (prior) return finish({ ...prior, idempotentSkip: true });
    const deliveredCase = mode === 'case' && runState.runs.find(item => item.kind === 'business-case' && item.date === date && item.sent === true);
    if (deliveredCase) return finish({ ...deliveredCase, idempotentSkip: true });

    // 夜间恢复任务只在当天尚未成功投递时补跑，正常日不产生额外模型调用或邮件。
    if (mode === 'recovery' && hasSentRunForDate(runState, date)) {
      const status = { runId, status: 'recovery-skipped', date, mode, sent: false, completedAt: new Date().toISOString() };
      recordRun(runStatePath, status);
      return finish(status);
    }

    const monthlyBudgetCny = monthlyBudgetForRun(now);
    if (mode !== 'scan' && !options.fixturePath && options.validateOnly !== true && monthlyBudgetCny <= 0) {
      const status = { runId, status: 'budget-stopped', date, mode, sent: false, completedAt: new Date().toISOString() };
      recordRun(path.join(stateDirectory, 'runs.json'), status);
      return finish(status);
    }

    // 定时任务或人工运行即使在窗口外启动，也必须在任何模型请求前正常停止。
    const modelAllowed = mode === 'case' ? isWeeklyCaseInvocationAllowed(now) : isModelInvocationAllowed(now);
    if (mode !== 'scan' && !options.fixturePath && options.validateOnly !== true && !modelAllowed) {
      const status = { runId, status: 'model-window-stopped', date, mode, sent: false, completedAt: new Date().toISOString() };
      recordRun(path.join(stateDirectory, 'runs.json'), status);
      return finish(status);
    }

    if (mode === 'final' && options.requireMorningReadiness === true && !options.fixturePath && !isMorningBriefingReady(now)) {
      const status = { runId, status: 'morning-window-not-ready', date, mode, sent: false, completedAt: new Date().toISOString() };
      recordRun(path.join(stateDirectory, 'runs.json'), status);
      return finish(status);
    }

    if (mode === 'case') {
      phase = 'weekly-case';
      log('phase-start');
      return finish(await runWeeklyCase({ root, outputDirectory, stateDirectory, date, runId, now, monthlyBudgetCny, send: options.send === true, validateOnly: options.validateOnly === true, services: options.caseServices }));
    }
    if (options.fixturePath) {
      phase = 'fixture-build';
      log('phase-start');
      const fixture = JSON.parse(fs.readFileSync(resolveFixturePath(root, options.fixturePath), 'utf8'));
      const result = runEditorialPipeline({ ...fixture, briefingDate: date });
      return finish(await finalizeArtifacts(result, { root, outputDirectory, runId, date, review: { passed: true, fixture: true }, send: false }));
    }

    phase = 'discovery';
    log('phase-start');
    const registry = JSON.parse(fs.readFileSync(projectPath(root, 'config/sources.v1.json'), 'utf8'));
    const sourceCollector = options.collectSources || collectSources;
    const discovery = await sourceCollector(registry, { cacheDirectory: projectPath(root, '.cache/discovery'), concurrency: 5 });
    writeJsonAtomic(path.join(outputDirectory, `discovery-${runId}.json`), discovery);
    const impaired = getImpairedCoverageGroups(discovery);
    if (options.mode === 'scan') {
      // 巡检的职责是记录瞬时来源健康状态，不能因单个来源网络波动制造 GitHub 失败告警。
      const result = {
        runId,
        status: impaired.length ? 'scan-impaired' : 'scan-complete',
        sourceCount: discovery.sourceCount,
        itemCount: discovery.itemCount,
        impairedCoverage: impaired.map((group) => ({ id: group.id, name: group.name, availableCount: group.availableCount, minimumAvailable: group.minimumAvailable })),
        completedAt: new Date().toISOString()
      };
      recordRun(path.join(stateDirectory, 'runs.json'), result);
      return finish(result);
    }
    if (impaired.length) {
      const error = new Error(`来源覆盖不足：${impaired.map((group) => group.name).join('、')}。`);
      error.code = 'COVERAGE_INSUFFICIENT';
      error.context = { impairedCoverage: impaired };
      throw error;
    }

    phase = 'details';
    log('phase-start');
    const { getCoverageWindow } = require('./pipeline.cjs');
    const trimmed = trimDiscoveryForWindow(discovery, getCoverageWindow(date));
    const details = await enrichDiscoveryItems(trimmed, registry, { cacheDirectory: projectPath(root, '.cache/details'), concurrency: 5 });

    phase = 'candidate-routing';
    log('phase-start');
    const sentStatePath = path.join(stateDirectory, 'sent-events.json');
    const candidates = filterPreviouslySent(prepareModelCandidates(details, date), readJson(sentStatePath, { events: [] }));
    if (candidates.candidateCount === 0) {
      const error = new Error('本期没有通过质量门槛的候选内容，停止生成。');
      error.code = 'NO_PUBLISHABLE_CONTENT';
      throw error;
    }
    if (options.validateOnly === true) {
      const status = { runId, status: 'validation-complete', date, candidateCount: candidates.candidateCount, rejectedCount: candidates.rejectedCount, sent: false, completedAt: new Date().toISOString() };
      recordRun(path.join(stateDirectory, 'runs.json'), status);
      return finish(status);
    }

    phase = 'generation-and-review';
    log('phase-start');
    const generated = await generateAndReview(candidates, {
      ledgerPath: path.join(stateDirectory, 'cost-ledger.json'),
      monthlyBudgetCny,
      budgetCostMultiplier: Number(process.env.BUDGET_COST_SAFETY_MULTIPLIER || 2),
      usdCnyRate: Number(process.env.USD_CNY_RATE || 7.2)
    });
    writeJsonAtomic(path.join(outputDirectory, `review-${runId}.json`), generated.review);

    phase = 'editorial-validation';
    log('phase-start');
    const result = runEditorialPipeline(generated.briefing);
    // 单条质量问题只应剔除该条内容；只要仍有合格事件，就继续生成晨报。
    // 先落盘审计信息，使全部拒绝时也能在私有运行产物中查看原因。
    const modelUsage = summarizeModelUsage(generated.costs);
    writeJsonAtomic(path.join(outputDirectory, `briefing-${date}.audit.json`), { ...result.audit, review: generated.review, modelUsage });
    assertPublishableEditorialResult(result);

    phase = 'artifact-finalization';
    log('phase-start');
    const finalized = await finalizeArtifacts(result, { root, outputDirectory, runId, date, review: generated.review, modelUsage, send: options.send === true });
    if (finalized.sent) updateSentState(sentStatePath, result.events);
    return finish(finalized);
  } catch (error) {
    log('run-error', { code: error?.code || 'UNEXPECTED', message: error.message });
    const delivered = mode === 'case' && readJson(path.join(stateDirectory, 'runs.json'), { runs: [] }).runs.find(item => item.runId === runId && item.sent === true);
    if (delivered) return finish({ ...delivered, postDeliveryWarning: error.message });
    if (error && error.code === 'MODEL_WINDOW_CLOSED') {
      const status = { runId, status: 'model-window-stopped', date, mode, phase, sent: false, completedAt: new Date().toISOString() };
      recordRun(path.join(stateDirectory, 'runs.json'), status);
      return finish(status);
    }
    // 服务商输出无法解析时已经尝试过一次完整重写。将诊断留在私有产物中，
    // 但不把可预期的供应商格式波动升级成 GitHub 的“任务失败”邮件。
    if (error && CONTROLLED_STOP_CODES.includes(error.code)) {
      const failurePath = writeFailure(outputDirectory, runId, phase, error, error.context);
      const status = {
        runId,
        status: error.code === 'MODEL_OUTPUT_INVALID'
          ? 'model-output-stopped'
            : error.code === 'COVERAGE_INSUFFICIENT'
              ? 'coverage-stopped'
            : error.code === 'CASE_REVIEW_BLOCKED'
              ? 'case-review-stopped'
            : error.code === 'MONTHLY_BUDGET_EXCEEDED' || error.code === 'DAILY_TOKEN_BUDGET_EXCEEDED'
              ? 'budget-stopped'
              : 'content-stopped',
        date,
        mode,
        phase,
        sent: false,
        failurePath,
        completedAt: new Date().toISOString()
      };
      recordRun(path.join(stateDirectory, 'runs.json'), status);
      return finish(status);
    }
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
  const now = options.now || new Date();
  const services = options.services || {};
  const readyPath = path.join(options.stateDirectory, 'weekly-case-ready.json');
  const auditPath = path.join(options.outputDirectory, 'business-case-' + options.date + '.audit.json');
  const history = readCaseHistory(options.stateDirectory, now);
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  let ready = readJson(readyPath, null);
  let sourceIds = [];
  let attempts = [];
  const reusable = ready && ready.version === 1 && ready.date === options.date && ready.review?.passed === true
    && !(ready.review.issues || []).some(issue => issue.severity === 'blocking')
    && ready.digest === hash({ content: ready.content, materials: ready.materials })
    && integrityIssues(ready.content, ready.materials).length === 0;
  if (!reusable || options.validateOnly) {
    const registry = JSON.parse(fs.readFileSync(path.join(options.root, 'config/sources.v1.json'), 'utf8'));
    sourceIds = weeklyCaseFallbackSourceIds(registry, history, now);
    let groups = [];
    if (sourceIds.length) {
      const discovery = await (services.collectSources || collectSources)(registry, { sourceIds, concurrency: 4 });
      const details = await (services.enrichDiscoveryItems || enrichDiscoveryItems)(trimCaseDiscovery(discovery), registry, { cacheDirectory: path.join(options.root, '.cache/details'), concurrency: 4 });
      groups = selectWeeklyCaseMaterialGroups(details, history, now);
      writeJsonAtomic(auditPath, { status: 'materials-checked', sourceIds, sourceHealth: (discovery.sources || []).map(source => ({ sourceId: source.sourceId, status: source.status, itemCount: source.itemCount, error: source.error || null })), detailCounts: { total: details.items.length, ready: details.items.filter(item => item.detailStatus === 'ready').length }, groups: groups.map(group => ({ entity: group[0].entityKey, count: group.length })), sent: false });
    }
    if (options.validateOnly) {
      const status = { runId: options.runId, date: options.date, mode: 'case', status: groups.length ? 'case-validation-complete' : 'case-materials-insufficient', candidateCount: groups.length, sent: false, completedAt: new Date().toISOString() };
      recordRun(path.join(options.stateDirectory, 'runs.json'), status);
      return status;
    }
    if (!groups.length) {
      const error = new Error('缺少一年内至少三份可核实材料组成的独立案例选题。');
      error.code = 'NO_PUBLISHABLE_CONTENT'; error.context = { sourceIds, minimumRequired: CASE_MATERIAL_MINIMUM };
      throw error;
    }
    ready = null;
    for (const materials of groups.slice(0,2)) {
      try {
        const generated = await (services.generateBusinessCase || generateBusinessCase)(materials, { now: options.now, allowWeeklyCase: true, ledgerPath: path.join(options.stateDirectory, 'cost-ledger.json'), monthlyBudgetCny: options.monthlyBudgetCny ?? monthlyBudgetForRun(now), budgetCostMultiplier: Number(process.env.BUDGET_COST_SAFETY_MULTIPLIER || 2), usdCnyRate: Number(process.env.USD_CNY_RATE || 7.2) });
        const content = generated.content;
        const issues = integrityIssues(content, materials);
        if (!generated.review?.passed || issues.length || (generated.review.issues || []).some(issue => issue.severity === 'blocking')) {
          const error = new Error('案例未满足投递前完整性或审校要求。'); error.code = 'CASE_REVIEW_BLOCKED'; error.context = { review: { passed: false, issues } }; throw error;
        }
        attempts.push({ entity: materials[0].entityKey, status: 'review-passed', reviews: generated.attempts || [] });
        ready = { version: 1, date: options.date, content, materials, review: generated.review, costs: generated.costs || [], attempts, digest: hash({ content, materials }) };
        writeJsonAtomic(readyPath, ready);
        break;
      } catch (error) {
        if (!['CASE_REVIEW_BLOCKED','MODEL_OUTPUT_INVALID'].includes(error.code)) throw error;
        attempts.push({ entity: materials[0].entityKey, status: error.code, review: error.context?.review || null, reviews: error.context?.attempts || [] });
        writeJsonAtomic(auditPath, { status: 'trying-alternative-topic', sourceIds, attempts, sent: false });
      }
    }
    if (!ready) {
      const error = new Error('两个独立案例选题经受限修复后仍未通过审校。');
      error.code = 'CASE_REVIEW_BLOCKED'; error.context = { sourceIds, attempts };
      writeJsonAtomic(auditPath, { status: 'review-blocked', ...error.context, sent: false });
      throw error;
    }
  }
  const { content, materials } = ready;
  const html = renderBusinessCase(content, options.date);
  const text = renderBusinessCaseText(content, options.date);
  const traceId = 'case-' + options.date;
  const mime = buildMimeMessage({ date: options.date, subject: '[商业案例] ' + content.title, senderName: PROJECT_CONFIG.senderName, from: PROJECT_CONFIG.senderAddress, to: PROJECT_CONFIG.recipientAddress, html, text, messageId: traceId, traceId });
  const base = 'business-case-' + options.date;
  fs.writeFileSync(path.join(options.outputDirectory, base + '.html'), html, 'utf8');
  fs.writeFileSync(path.join(options.outputDirectory, base + '.txt'), text, 'utf8');
  fs.writeFileSync(path.join(options.outputDirectory, base + '.eml'), mime, 'utf8');
  let delivery;
  writeJsonAtomic(auditPath, { status: 'ready-to-send', review: ready.review, attempts: ready.attempts, reusedReviewedDraft: Boolean(reusable), sourceCount: content.sources.length, modelUsage: summarizeModelUsage(ready.costs), sent: false });
  if (options.send) {
    const submission = await (services.sendWithRetry || sendWithRetry)(mime, { enabled: true });
    if (submission.status !== 250) throw new Error('案例未取得 SMTP 250 接受回执。');
    delivery = { traceId, smtpStatus: submission.status, attempts: submission.attempts, submission: submission.submission, acceptedAt: new Date().toISOString() };
  }
  const sent = Boolean(delivery);
  // 先登记SMTP成功，再写选题历史；后续补跑按该周日期去重。
  const status = { runId: options.runId, status: 'complete', kind: 'business-case', date: options.date, sent, delivery, reusedReviewedDraft: Boolean(reusable), completedAt: new Date().toISOString() };
  recordRun(path.join(options.stateDirectory, 'runs.json'), status);
  if (sent) updateCaseHistory(options.stateDirectory, content, materials, now);
  writeJsonAtomic(auditPath, { status: sent ? 'sent' : 'validated-not-sent', review: ready.review, attempts: ready.attempts, reusedReviewedDraft: Boolean(reusable), sourceCount: content.sources.length, modelUsage: summarizeModelUsage(ready.costs), sent, smtpStatus: delivery?.smtpStatus || null });
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
  const subject = options.subject || `[全球晨报] ${options.date}`;
  const traceId = `briefing-${options.runId}`;
  const mime = buildMimeMessage({ date: options.date, subject, senderName: PROJECT_CONFIG.senderName, from: PROJECT_CONFIG.senderAddress, to: PROJECT_CONFIG.recipientAddress, html, text, messageId: traceId, traceId });
  fs.writeFileSync(path.join(options.outputDirectory, `${base}.html`), html, 'utf8');
  fs.writeFileSync(path.join(options.outputDirectory, `${base}.txt`), text, 'utf8');
  fs.writeFileSync(path.join(options.outputDirectory, `${base}.eml`), mime, 'utf8');
  writeJsonAtomic(path.join(options.outputDirectory, `${base}.selected.json`), {
    briefingDate: result.briefingDate,
    coverageStart: result.window.start.toISOString(),
    coverageEnd: result.window.end.toISOString(),
    events: result.events,
    coverage: result.coverage || null,
    // 私有补发必须能还原完整邮件，包含不涉及来源事实的独立思考段。
    thinking: result.thinking || null
  });
  writeJsonAtomic(path.join(options.outputDirectory, `${base}.audit.json`), { ...result.audit, review: options.review, modelUsage: options.modelUsage });
  let sent = false;
  let delivery;
  if (options.send) {
    const submission = await sendWithRetry(mime, { enabled: true });
    sent = true;
    delivery = { traceId, smtpStatus: submission.status, attempts: submission.attempts, submission: submission.submission, acceptedAt: new Date().toISOString() };
  }
  const status = { runId: options.runId, status: 'complete', date: options.date, eventCount: result.events.length, sent, delivery, completedAt: new Date().toISOString() };
  recordRun(path.join(options.root, 'state/runs.json'), status);
  return status;
}

module.exports = { assertPublishableEditorialResult, beijingDate, caseEntityKey, finalizeArtifacts, getImpairedCoverageGroups, hasSentRunForDate, monthlyBudgetForRun, projectPath, purgeDetailCache, readCaseHistory, resolveFixturePath, runDaily, runWeeklyCase, selectWeeklyCaseMaterialGroups, selectWeeklyCaseMaterials, selectedEventsFromOutput, summarizeModelUsage, trimCaseDiscovery, trimDiscoveryForWindow, updateCaseHistory, weeklyCaseFallbackSourceIds, weeklyCaseSeeds, writeFailure };
