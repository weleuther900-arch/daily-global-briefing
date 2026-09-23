'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const DAY = 86400000;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_THRESHOLDS = { dailyStars: 100, smallDailyStars: 30, dailyRate: 0.1, weeklyStars: 500, smallWeeklyStars: 100, weeklyRate: 0.25 };

function integer(value) {
  const text = String(value ?? '').trim().replaceAll(',', '');
  return /^\d+$/.test(text) ? Number(text) : null;
}

function parseTrendingMetrics(html, period) {
  const { stripMarkup } = require('./discovery.cjs');
  const records = [];
  for (const match of String(html).matchAll(/<article\b[^>]*class=["'][^"']*Box-row[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)) {
    const card = match[1];
    const name = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["']\/([^"']+)["']/i.exec(card)?.[1];
    if (!REPO.test(name || '')) continue;
    const total = /<a\b[^>]*href=["'][^"']+\/stargazers["'][^>]*>([\s\S]*?)<\/a>/i.exec(card)?.[1];
    const recent = /([\d,]+)\s+stars?\s+(today|this week)\b/i.exec(stripMarkup(card));
    records.push({ name, stars: total == null ? null : integer(stripMarkup(total)), description: stripMarkup(/<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(card)?.[1] || ''),
      reported: recent && recent[2].toLowerCase() === (period === 'daily' ? 'today' : 'this week') ? { period, added: integer(recent[1]), sourceUrl: `https://github.com/trending?since=${period}` } : null });
  }
  return records;
}

function windowChange(points, current, days, tolerance) {
  if (!Number.isInteger(current.stars)) return null;
  const time = Date.parse(current.at), target = time - days * DAY;
  const baseline = points.filter(p => Number.isInteger(p.stars) && p.stars >= 0 && Date.parse(p.at) < time && Math.abs(Date.parse(p.at) - target) <= tolerance * DAY)
    .sort((a,b) => Math.abs(Date.parse(a.at) - target) - Math.abs(Date.parse(b.at) - target))[0];
  if (!baseline) return null;
  const hours = (time - Date.parse(baseline.at)) / 3600000;
  const net = current.stars - baseline.stars;
  return { from: baseline.at, to: current.at, hours, baselineStars: baseline.stars, net, rate: baseline.stars > 0 ? net / baseline.stars : null, perDay: net * 24 / hours };
}

function parseStarHistory(payload, name, observedAt) {
  if (!Array.isArray(payload)) throw new Error('Star历史响应不是数组。');
  const now = Date.parse(observedAt);
  return payload.filter(w => Number.isInteger(w.week) && w.week * 1000 <= now && w.week * 1000 >= now - 8 * DAY
    && Array.isArray(w.days) && w.days.length === 7 && w.days.every(n => Number.isInteger(n) && n >= 0)
    && Number.isInteger(w.total) && w.total === w.days.reduce((sum,n) => sum+n,0))
    .sort((a,b) => b.week-a.week).slice(0,1)
    .map(w => ({kind:'history',period:'weekly',added:w.total,days:w.days,weekReference:new Date(w.week*1000).toISOString(),sourceUrl:`https://api.github.com/repos/${name}/stargazers/history`}));
}

function assessMomentum(record, points, observedAt, thresholds = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const current = { at: observedAt, stars: record.stars };
  const daily = windowChange(points, current, 1, 0.25);
  const weekly = windowChange(points, current, 7, 1);
  const previous = daily ? windowChange(points, { at: daily.from, stars: daily.baselineStars }, 1, 0.25) : null;
  const acceleration = daily && previous && previous.perDay > 0 ? daily.perDay / previous.perDay : null;
  const reported = (record.reported || []).filter(r => Number.isInteger(r.added) && r.added >= 0);
  const qualifies = (added, rate, period) => period === 'daily'
    ? added >= limits.dailyStars || (added >= limits.smallDailyStars && rate != null && rate >= limits.dailyRate)
    : added >= limits.weeklyStars || (added >= limits.smallWeeklyStars && rate != null && rate >= limits.weeklyRate);
  const signals = [];
  if (daily && qualifies(daily.perDay, daily.rate, 'daily')) signals.push('snapshot-daily');
  if (weekly && qualifies(weekly.net * 7 * 24 / weekly.hours, weekly.rate, 'weekly')) signals.push('snapshot-weekly');
  for (const r of reported) if (qualifies(r.added, null, r.period)) signals.push(`github-reported-${r.period}`);
  for (const r of reported) if (r.kind === 'history' && Math.max(...r.days) >= limits.dailyStars) signals.push('github-history-recent-day');
  // 只按可核验的近期增量排序；累计Star和新建日期都不能使项目自动入选。
  const dailyScale = Math.max(0, daily?.perDay || 0, (weekly?.perDay || 0), ...reported.map(r => r.kind === 'history' ? Math.max(...r.days) : r.added / (r.period === 'weekly' ? 7 : 1)));
  const score = Math.log1p(dailyScale) + Math.min(1, Math.max(0, daily?.rate || weekly?.rate || 0));
  return { qualifies: signals.length > 0, signals, score, totalStars: record.stars, daily, weekly, acceleration, reported,
    historyStatus: daily ? (weekly ? 'daily-and-weekly' : 'daily-only') : weekly ? 'weekly-only' : 'insufficient' };
}

function evidenceText(record, metrics, observedAt) {
  const lines = [`GitHub项目关注度观察：${observedAt}，不是项目发布日期。`, `项目：${record.name}；仓库作者说明（未经独立实测）：${record.description || '未提供用途说明'}`,
    `当前累计Star：${metrics.totalStars ?? '未获得精确值'}。只表示关注，不等于用户数、采用率或商业成功。`];
  for (const period of ['daily', 'weekly']) {
    const m = metrics[period];
    if (m) lines.push(`本地快照证据：${m.from} 至 ${m.to}（实际${m.hours.toFixed(1)}小时），Star净增${m.net}，基数${m.baselineStars}，净增长率${m.rate == null ? '基数为零，不计算' : (m.rate * 100).toFixed(1) + '%'}。净增包含取消Star影响。`);
  }
  for (const r of metrics.reported) {
    if (r.kind === 'history') lines.push(`GitHub官方历史统计：周起点参考戳${r.weekReference}，该周截至观察时共新增${r.added} Star；按周日至周六顺序每日计数[${r.days.join(', ')}]。自然周可能尚未结束，未来日零值不代表降温；平台日界线不保证与UTC一致，不能写成精确滚动24小时或7天。证据链接：${r.sourceUrl}`);
    else lines.push(`GitHub平台页面标示：${r.period === 'daily' ? 'today' : 'this week'}新增${r.added} Star；平台周期，不冒充精确滚动24小时或7天。证据链接：${r.sourceUrl}`);
  }
  if (metrics.acceleration != null) lines.push(`相邻两个约一天观测区间的日均净增比为${metrics.acceleration.toFixed(2)}倍；只能据此描述变化，不外推趋势。`);
  if (!metrics.daily) lines.push('缺少可比的约一天本地快照，不能计算日净增长率或以快照确认突然加速。');
  if (!metrics.weekly) lines.push('缺少可比的一周本地快照，不能计算整周净增长率；平台新增另按其口径说明。');
  if (record.readme) lines.push(`仓库README摘录（作者说明，未独立实测，也未核实采用许可）：\n${record.readme}`);
  return lines.join('\n');
}

async function requestText(url, options) {
  const parsed = new URL(url);
  if (!['github.com', 'api.github.com'].includes(parsed.hostname) || parsed.protocol !== 'https:') throw new Error('GitHub请求域名无效。');
  const headers = { Accept: parsed.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'text/html', 'User-Agent': 'DailyGlobalBriefing/0.1' };
  if (parsed.hostname === 'api.github.com' && process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(url, { headers, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs || 15000) });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const content = await response.text();
    if (Buffer.byteLength(content) > 3 * 1024 * 1024) throw new Error('GitHub响应超过大小限制。');
    return content;
  } catch (error) {
    // 仅网络传输失败使用无凭据curl。权限和限流错误保留为失败，不尝试绕过。
    if (options.fetchImpl || options.enableCurlFallback === false || !['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)) throw error;
    const { fetchWithCurl } = require('./discovery.cjs');
    return (await fetchWithCurl({ discovery: { url, allowedHosts: [parsed.hostname] } }, options.timeoutMs || 15000)).content;
  }
}

async function collectGithubMomentum(source, options = {}) {
  const started = Date.now(), now = new Date(options.now || Date.now()), observedAt = now.toISOString();
  const { writeJsonAtomic } = require('./discovery.cjs');
  const statePath = options.cacheDirectory ? path.join(options.cacheDirectory, 'github-star-history.json') : null;
  let history = { version: 1, repositories: {} };
  if (statePath && fs.existsSync(statePath)) {
    try { const saved = JSON.parse(fs.readFileSync(statePath, 'utf8')); if (saved.version === 1 && saved.repositories && typeof saved.repositories === 'object') history = saved; }
    catch { /* 损坏历史按冷启动处理，不推算不存在的增长。 */ }
  }
  const failures = [], records = new Map();
  let successfulFeeds = 0;
  function merge(record) {
    if (!REPO.test(record.name || '') || record.archived || record.fork || record.private) return;
    const key = record.name.toLowerCase(), old = records.get(key);
    records.set(key, { ...old, ...record, stars: Number.isInteger(record.stars) ? record.stars : old?.stars ?? null,
      reported: [...(old?.reported || []), ...(record.reported ? [record.reported] : [])] });
  }
  const feeds = ['daily', 'weekly'].map(period => ({ label: `trending-${period}`, url: `https://github.com/trending?since=${period}`, period }));
  const cutoff = days => new Date(now.getTime() - days * DAY).toISOString().slice(0,10);
  feeds.push({ label: 'recent-project-search', url: `https://api.github.com/search/repositories?q=${encodeURIComponent(`is:public fork:false archived:false stars:>=30 created:>=${cutoff(30)}`)}&sort=stars&order=desc&per_page=30` });
  feeds.push({ label: 'active-project-search', url: `https://api.github.com/search/repositories?q=${encodeURIComponent(`is:public fork:false archived:false stars:>=100 pushed:>=${cutoff(7)}`)}&sort=updated&order=desc&per_page=30` });
  await Promise.all(feeds.map(async feed => {
    try {
      const content = await requestText(feed.url, options);
      if (feed.period) {
        const parsed = parseTrendingMetrics(content, feed.period);
        if (!parsed.length) throw new Error('榜单卡片为空或结构改变。');
        parsed.forEach(merge);
      } else {
        const result = JSON.parse(content);
        if (!Array.isArray(result.items)) throw new Error('搜索响应缺少items。');
        if (result.incomplete_results) failures.push({ feed: feed.label, error: '搜索返回不完整结果。' });
        result.items.forEach(repo => merge({ name: repo.full_name, stars: repo.stargazers_count, description: repo.description || '', archived: repo.archived, fork: repo.fork, private: repo.private }));
      }
      successfulFeeds += 1;
    } catch (error) { failures.push({ feed: feed.label, error: error.message }); }
  }));
  // 已离开榜单/搜索结果的观察对象继续抽样跟踪。轮换最久未观测对象，避免候选池固化。
  const tracked = Object.entries(history.repositories).filter(([name,entry]) => REPO.test(name) && !records.has(name.toLowerCase()) && Date.parse(entry.lastSeen) >= now.getTime() - 35 * DAY)
    .sort((a,b) => Date.parse(a[1].lastSeen) - Date.parse(b[1].lastSeen)).slice(0,24);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, tracked.length) }, async () => {
    while (cursor < tracked.length) {
      const [name] = tracked[cursor++];
      try {
        const repo = JSON.parse(await requestText(`https://api.github.com/repos/${name}`, options));
        merge({ name: repo.full_name, stars: repo.stargazers_count, description: repo.description || '', archived: repo.archived, fork: repo.fork, private: repo.private });
      } catch (error) { failures.push({ feed: `tracked:${name}`, error: error.message }); }
    }
  }));
  // 官方聚合历史不包含个人Star名单。轮换核验候选，冷启动也可发现未上榜的增长项目。
  const historyChecks = [...records.entries()].sort((a,b) => Date.parse(history.repositories[a[0]]?.historyCheckedAt || 0) - Date.parse(history.repositories[b[0]]?.historyCheckedAt || 0)).slice(0,24);
  let historyCursor = 0, verifiedHistories = 0;
  await Promise.all(Array.from({length:Math.min(4,historyChecks.length)},async()=>{
    while (historyCursor < historyChecks.length) {
      const [key,record] = historyChecks[historyCursor++];
      try {
        const payload = JSON.parse(await requestText(`https://api.github.com/repos/${record.name}/stargazers/history?per_page=2`,options));
        record.reported.push(...parseStarHistory(payload,record.name,observedAt));
        verifiedHistories += 1;
        const entry = history.repositories[key] || {lastSeen:observedAt,points:[]};
        entry.historyCheckedAt = observedAt;
        history.repositories[key] = entry;
      } catch (error) { failures.push({feed:`history:${record.name}`,error:error.message}); }
    }
  }));
  const assessed = [];
  for (const [key,record] of records) {
    const points = (history.repositories[key]?.points || []).filter(p => Number.isInteger(p.stars) && p.stars >= 0 && Date.parse(p.at) <= now.getTime() && Date.parse(p.at) >= now.getTime() - 35 * DAY);
    const metrics = assessMomentum(record, points, observedAt, source.discovery.momentumThresholds);
    assessed.push({ record, metrics });
    if (Number.isInteger(record.stars) && record.stars >= 0) {
      // 同一小时重跑替换快照；不伪造多个独立观测点。
      const retained = points.filter(p => observedAt.slice(0,13) !== p.at.slice(0,13));
      history.repositories[key] = { historyCheckedAt: history.repositories[key]?.historyCheckedAt || null, lastSeen: observedAt, points: [...retained, { at: observedAt, stars: record.stars }].sort((a,b) => Date.parse(a.at) - Date.parse(b.at)).slice(-96) };
    }
  }
  history.repositories = Object.fromEntries(Object.entries(history.repositories).filter(([,e]) => Date.parse(e.lastSeen) >= now.getTime() - 35 * DAY).sort((a,b) => Date.parse(b[1].lastSeen) - Date.parse(a[1].lastSeen)).slice(0,500));
  if (statePath) writeJsonAtomic(statePath, history);
  const qualified = assessed.filter(x => x.metrics.qualifies).sort((a,b) => b.metrics.score - a.metrics.score);
  const retained = qualified.slice(0, source.discovery.maxItems || 25);
  // 为排在前面的项目补充真实用途材料。缺失说明必须留白，不能让模型按名字猜功能。
  let readmeCursor = 0;
  const withReadme = retained.slice(0,8);
  await Promise.all(Array.from({length: Math.min(4,withReadme.length)}, async () => {
    while (readmeCursor < withReadme.length) {
      const {record} = withReadme[readmeCursor++];
      try {
        const result = JSON.parse(await requestText(`https://api.github.com/repos/${record.name}/readme`, options));
        if (result.encoding !== 'base64' || typeof result.content !== 'string') throw new Error('README未返回可读内容。');
        record.readme = Buffer.from(result.content,'base64').toString('utf8').slice(0,3000);
      } catch (error) { failures.push({feed:`readme:${record.name}`,error:error.message}); }
    }
  }));
  const items = retained.map(({ record, metrics }) => {
    const url = `https://github.com/${record.name}`;
    return { sourceId: source.id, sourceName: source.name, sourceTier: source.tier, sourceKind: source.kind, topics: source.topics,
      title: record.name, url, publishedAt: observedAt, fingerprint: crypto.createHash('sha256').update(`${source.id}|${url}`).digest('hex').slice(0,20), needsDetailFetch: true,
      observation: { kind: 'github-momentum', observedAt, repositoryUrl: url, sourceUrl: `https://api.github.com/repos/${record.name}`, metrics },
      prefetchedText: evidenceText(record, metrics, observedAt), prefetchedLanguage: 'und', prefetchedTransport: 'github-momentum' };
  });
  return { sourceId: source.id, sourceName: source.name, status: successfulFeeds ? 'healthy' : 'failed', contentStatus: items.length ? 'items' : 'empty',
    itemCount: items.length, items, durationMs: Date.now() - started,
    momentumAudit: { observedAt, successfulFeeds, partialCoverage: failures.length > 0, searched: records.size, tracked: tracked.length, historyChecked:historyChecks.length, verifiedHistories, qualified: qualified.length, retained: items.length, failures,
      assessments: assessed.map(({record,metrics}) => ({ repository: record.name, ...metrics })) },
    ...(successfulFeeds ? {} : { error: 'GitHub发现入口均不可用；详情见momentumAudit。' }) };
}

module.exports = { assessMomentum, collectGithubMomentum, evidenceText, parseStarHistory, parseTrendingMetrics, windowChange };
