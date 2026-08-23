'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DISCOVERY_TYPES = new Set(['rss', 'html', 'json', 'github-trending', 'x-api']);
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_ITEMS_PER_SOURCE = 60;
const CACHE_SCHEMA_VERSION = 2;

function decodeEntities(value) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '
  };
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([0-9a-f]+);/gi, (_, number) => String.fromCodePoint(parseInt(number, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function stripMarkup(value) {
  return decodeEntities(value).replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePublishedAt(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getTag(block, names) {
  for (const name of names) {
    const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
    const match = pattern.exec(block);
    if (match) return stripMarkup(match[1]);
  }
  return '';
}

function getRssLink(block) {
  const atomLink = /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i.exec(block);
  if (atomLink) return decodeEntities(atomLink[1]).trim();
  return getTag(block, ['link']);
}

function isAllowedUrl(value, allowedHosts) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && allowedHosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function makeDiscoveryItem(source, title, url, publishedAt, externalId = '') {
  const normalizedTitle = stripMarkup(title);
  if (normalizedTitle.length < 4 || !isAllowedUrl(url, source.discovery.allowedHosts)) return null;
  const normalizedUrl = new URL(url).toString();
  const fingerprint = crypto.createHash('sha256')
    .update(`${source.id}|${externalId || normalizedUrl}`)
    .digest('hex')
    .slice(0, 20);
  return {
    sourceId: source.id,
    sourceName: source.name,
    sourceTier: source.tier,
    sourceKind: source.kind,
    topics: source.topics,
    title: normalizedTitle,
    url: normalizedUrl,
    publishedAt: normalizePublishedAt(publishedAt),
    fingerprint,
    needsDetailFetch: true
  };
}

function parseXApi(content, source) {
  const payload = typeof content === 'string' ? JSON.parse(content) : content;
  const usernames = new Map((payload.includes?.users || []).map((user) => [String(user.id), user.username]));
  const items = (payload.data || []).map((post) => {
    const username = usernames.get(String(post.author_id)) || 'i';
    const text = stripMarkup(post.text || '');
    const title = `X官方发布｜@${username}｜${text.replace(/\s+/g, ' ').slice(0, 140)}`;
    const item = makeDiscoveryItem(source, title, `https://x.com/${username}/status/${post.id}`, post.created_at, String(post.id));
    return item && { ...item, prefetchedText: text, prefetchedLanguage: 'und', prefetchedTransport: 'x-api' };
  });
  return uniqueItems(items, source.discovery.maxItems || 25);
}

function uniqueItems(items, limit = MAX_ITEMS_PER_SOURCE) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function parseRssOrAtom(content, source) {
  const itemMatches = [...String(content).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  const entryMatches = [...String(content).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
  const blocks = itemMatches.length > 0 ? itemMatches.map((match) => match[1]) : entryMatches.map((match) => match[1]);
  return uniqueItems(blocks.map((block) => makeDiscoveryItem(
    source,
    getTag(block, ['title']),
    getRssLink(block),
    getTag(block, ['pubDate', 'published', 'updated', 'dc:date']),
    getTag(block, ['guid', 'id'])
  )), source.discovery.maxItems || MAX_ITEMS_PER_SOURCE);
}

function parseHtmlLinks(content, source, responseUrl = source.discovery.url) {
  const pattern = new RegExp(source.discovery.linkPattern);
  const excludePattern = source.discovery.excludeLinkPattern ? new RegExp(source.discovery.excludeLinkPattern) : null;
  const items = [];
  const html = String(content);
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let resolved;
    try {
      resolved = new URL(decodeEntities(match[1]), responseUrl).toString();
    } catch {
      continue;
    }
    if (!pattern.test(resolved) || (excludePattern && excludePattern.test(resolved))) continue;
    items.push(makeDiscoveryItem(source, match[2], resolved, extractNearbyPublishedAt(html, match.index, match[0].length)));
  }
  return uniqueItems(items, source.discovery.maxItems || MAX_ITEMS_PER_SOURCE);
}

function extractNearbyPublishedAt(html, anchorIndex, anchorLength) {
  const context = stripMarkup(html.slice(Math.max(0, anchorIndex - 100), anchorIndex + anchorLength + 180));
  const numeric = /(20\d{2})[年/.-](\d{1,2})[月/.-](\d{1,2})日?/.exec(context);
  if (numeric) {
    const value = new Date(`${numeric[1]}-${String(numeric[2]).padStart(2, '0')}-${String(numeric[3]).padStart(2, '0')}T04:00:00Z`);
    if (!Number.isNaN(value.getTime())) return value.toISOString();
  }
  const english = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s+20\d{2}\b/i.exec(context);
  if (english) {
    const value = new Date(`${english[0]} 12:00:00 UTC`);
    if (!Number.isNaN(value.getTime())) return value.toISOString();
  }
  return null;
}

function getPathValue(value, pathExpression) {
  return String(pathExpression || '').split('.').filter(Boolean)
    .reduce((current, key) => current == null ? undefined : current[key], value);
}

function parseJsonDiscovery(content, source) {
  const payload = typeof content === 'string' ? JSON.parse(content) : content;
  const items = getPathValue(payload, source.discovery.itemsPath);
  if (!Array.isArray(items)) throw new Error('JSON来源的itemsPath没有指向数组。');
  return uniqueItems(items.map((item) => makeDiscoveryItem(
    source,
    getPathValue(item, source.discovery.titleField),
    getPathValue(item, source.discovery.urlField),
    getPathValue(item, source.discovery.dateField),
    String(getPathValue(item, 'document_number') || getPathValue(item, 'id') || '')
  )), source.discovery.maxItems || MAX_ITEMS_PER_SOURCE);
}

function parseGithubTrending(content, source, observedAt = new Date()) {
  const items = [];
  for (const match of String(content).matchAll(/<article\b[^>]*class=["'][^"']*Box-row[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)) {
    const heading = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=["'](\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(match[1]);
    if (!heading) continue;
    const repository = heading[1].slice(1);
    items.push(makeDiscoveryItem(source, repository, new URL(heading[1], source.discovery.url).toString(), observedAt.toISOString()));
  }
  return uniqueItems(items, source.discovery.maxItems || 25);
}

function parseSourceContent(content, source, responseUrl) {
  switch (source.discovery.type) {
    case 'rss': return parseRssOrAtom(content, source);
    case 'html': return parseHtmlLinks(content, source, responseUrl);
    case 'json': return parseJsonDiscovery(content, source);
    case 'github-trending': return parseGithubTrending(content, source);
    case 'x-api': return parseXApi(content, source);
    default: throw new Error(`不支持的发现类型：${source.discovery.type}`);
  }
}

function validateRegistry(registry) {
  const errors = [];
  const ids = new Set();
  if (!registry || !Array.isArray(registry.sources)) return ['注册表缺少sources数组。'];

  for (const source of registry.sources) {
    if (!source.id || !/^[a-z0-9-]+$/.test(source.id)) errors.push('来源id只能使用小写字母、数字和连字符。');
    else if (ids.has(source.id)) errors.push(`来源id重复：${source.id}。`);
    else ids.add(source.id);
    if (!source.name || !source.tier || !source.kind || !Array.isArray(source.topics)) errors.push(`${source.id || '未知来源'}缺少基础字段。`);
    if (!source.discovery || !DISCOVERY_TYPES.has(source.discovery.type)) errors.push(`${source.id || '未知来源'}的发现类型无效。`);
    if (!source.discovery || !Array.isArray(source.discovery.allowedHosts) || source.discovery.allowedHosts.length === 0) {
      errors.push(`${source.id || '未知来源'}缺少域名白名单。`);
      continue;
    }
    if (!isAllowedUrl(source.discovery.url, source.discovery.allowedHosts)) errors.push(`${source.id || '未知来源'}的入口不在自身域名白名单内。`);
    if (source.discovery.type === 'html' && !source.discovery.linkPattern) errors.push(`${source.id}缺少HTML链接规则。`);
    if (source.discovery.maxItems != null && (!Number.isInteger(source.discovery.maxItems) || source.discovery.maxItems < 1 || source.discovery.maxItems > MAX_ITEMS_PER_SOURCE)) {
      errors.push(`${source.id}的maxItems必须是1至${MAX_ITEMS_PER_SOURCE}之间的整数。`);
    }
    if (source.discovery.type === 'json' && (!source.discovery.itemsPath || !source.discovery.titleField || !source.discovery.urlField)) {
      errors.push(`${source.id}缺少JSON字段映射。`);
    }
    if (source.discovery.type === 'x-api' && !source.discovery.query) errors.push(`${source.id}缺少X API查询表达式。`);
  }
  for (const group of registry.coverageGroups || []) {
    if (!group.id || !group.name || !Array.isArray(group.sourceIds) || group.sourceIds.length === 0) {
      errors.push('存在字段不完整的覆盖组。');
      continue;
    }
    if (!Number.isInteger(group.minimumAvailable) || group.minimumAvailable < 1 || group.minimumAvailable > group.sourceIds.length) {
      errors.push(`覆盖组${group.id}的minimumAvailable无效。`);
    }
    for (const sourceId of group.sourceIds) {
      if (!ids.has(sourceId)) errors.push(`覆盖组${group.id}引用未知来源：${sourceId}。`);
    }
  }
  return errors;
}

function readCache(cachePath) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporaryPath, targetPath);
}

async function fetchWithCurl(source, timeoutMs) {
  const marker = '__DGB_CURL_META__';
  let stdout;
  try {
    ({ stdout } = await execFileAsync('curl.exe', [
      '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '--silent',
      '--show-error',
      '--location',
      '--user-agent', source.discovery.userAgent || 'DailyGlobalBriefing/0.1',
      '--header', 'Accept: application/rss+xml, application/atom+xml, application/json, text/xml, text/html;q=0.9, */*;q=0.5',
      '--write-out', `\n${marker}%{http_code}\t%{url_effective}`,
      source.discovery.url
    ], {
      encoding: 'utf8',
      timeout: timeoutMs + 2000,
      maxBuffer: MAX_RESPONSE_BYTES + 64 * 1024,
      windowsHide: true
    }));
  } catch (error) {
    throw new Error(`curl连接失败（退出码：${error.code || '未知'}）。`);
  }
  const markerIndex = stdout.lastIndexOf(`\n${marker}`);
  if (markerIndex < 0) throw new Error('curl没有返回状态信息。');
  const content = stdout.slice(0, markerIndex);
  const [statusText, finalUrl] = stdout.slice(markerIndex + marker.length + 1).trim().split('\t');
  const status = Number(statusText);
  if (!Number.isInteger(status) || status < 200 || status >= 300) throw new Error(`HTTP ${statusText || '未知'}`);
  if (!isAllowedUrl(finalUrl, source.discovery.allowedHosts)) throw new Error('curl重定向目标不在来源域名白名单内。');
  if (Buffer.byteLength(content, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('响应超过大小限制。');
  return { content, finalUrl, status };
}

async function fetchSource(source, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前Node.js运行时不支持fetch。');
  const cacheDirectory = options.cacheDirectory;
  const cachePath = cacheDirectory ? path.join(cacheDirectory, `${source.id}.json`) : null;
  const previous = cachePath ? readCache(cachePath) : null;
  const currentCache = previous && previous.schemaVersion === CACHE_SCHEMA_VERSION ? previous : null;
  const headers = {
    'Accept': source.discovery.type === 'json' ? 'application/json' : 'application/rss+xml, application/atom+xml, text/xml, text/html;q=0.9, */*;q=0.5',
    'User-Agent': source.discovery.userAgent || 'DailyGlobalBriefing/0.1 (+personal research; contact via repository owner)'
  };
  let requestUrl = source.discovery.url;
  if (source.discovery.type === 'x-api') {
    const bearerToken = process.env.X_BEARER_TOKEN;
    if (!bearerToken) {
      return { sourceId: source.id, sourceName: source.name, status: 'skipped', skipped: true, itemCount: 0, durationMs: 0, items: [], error: '未配置X_BEARER_TOKEN，跳过可选X来源。' };
    }
    const search = new URL(source.discovery.url);
    search.searchParams.set('query', source.discovery.query);
    search.searchParams.set('max_results', String(source.discovery.maxItems || 25));
    search.searchParams.set('tweet.fields', 'created_at,author_id');
    search.searchParams.set('expansions', 'author_id');
    search.searchParams.set('user.fields', 'username,name,verified');
    requestUrl = search.toString();
    headers.Authorization = `Bearer ${bearerToken}`;
    headers.Accept = 'application/json';
  }
  if (currentCache && currentCache.etag) headers['If-None-Match'] = currentCache.etag;
  if (currentCache && currentCache.lastModified) headers['If-Modified-Since'] = currentCache.lastModified;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 20000);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(requestUrl, {
      headers,
      redirect: 'follow',
      signal: controller.signal
    });
    const finalUrl = response.url || source.discovery.url;
    if (!isAllowedUrl(finalUrl, source.discovery.allowedHosts)) throw new Error('重定向目标不在来源域名白名单内。');

    if (response.status === 304 && currentCache) {
      return {
        sourceId: source.id,
        sourceName: source.name,
        // 304表示来源可正常访问，只是内容未变；没有新条目不能被当作来源故障。
        status: 'healthy',
        contentStatus: currentCache.items.length > 0 ? 'items' : 'empty',
        httpStatus: 304,
        cached: true,
        itemCount: currentCache.items.length,
        durationMs: Date.now() - startedAt,
        items: currentCache.items
      };
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error('响应超过大小限制。');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RESPONSE_BYTES) throw new Error('响应超过大小限制。');
    const content = buffer.toString('utf8');
    const items = parseSourceContent(content, source, finalUrl);
    // 某一天没有可匹配的新文章是正常业务状态。覆盖组只应因连接、权限或解析异常而降级，
    // 不应因此阻止当天的正式晨报。
    const healthStatus = 'healthy';
    const cacheValue = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      sourceId: source.id,
      fetchedAt: new Date().toISOString(),
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      items
    };
    if (cachePath) writeJsonAtomic(cachePath, cacheValue);
    return {
      sourceId: source.id,
      sourceName: source.name,
      status: healthStatus,
      contentStatus: items.length > 0 ? 'items' : 'empty',
      httpStatus: response.status,
      cached: false,
      itemCount: items.length,
      durationMs: Date.now() - startedAt,
      items
    };
  } catch (error) {
    const canUseCurl = source.discovery.type !== 'x-api' && options.enableCurlFallback !== false &&
      (error.message === 'fetch failed' || error.name === 'TypeError' || error.name === 'AbortError' || /^HTTP (403|429|5\d\d)$/.test(error.message));
    if (canUseCurl) {
      try {
        const curlResponse = await fetchWithCurl(source, options.timeoutMs || 20000);
        const items = parseSourceContent(curlResponse.content, source, curlResponse.finalUrl);
        const healthStatus = 'healthy';
        const cacheValue = {
          schemaVersion: CACHE_SCHEMA_VERSION,
          sourceId: source.id,
          fetchedAt: new Date().toISOString(),
          etag: null,
          lastModified: null,
          items
        };
        if (cachePath) writeJsonAtomic(cachePath, cacheValue);
        return {
          sourceId: source.id,
          sourceName: source.name,
          status: healthStatus,
          contentStatus: items.length > 0 ? 'items' : 'empty',
          httpStatus: curlResponse.status,
          cached: false,
          transport: 'curl-fallback',
          itemCount: items.length,
          durationMs: Date.now() - startedAt,
          items
        };
      } catch (curlError) {
        error = new Error(`${error.message}；curl备用路径：${curlError.message}`);
      }
    }
    return {
      sourceId: source.id,
      sourceName: source.name,
      status: 'failed',
      httpStatus: null,
      cached: false,
      itemCount: 0,
      durationMs: Date.now() - startedAt,
      error: error.name === 'AbortError' ? '请求超时。' : error.message,
      items: []
    };
  } finally {
    clearTimeout(timeout);
  }
}

function auditCoverageGroups(registry, sourceResults) {
  const statusById = new Map(sourceResults.map((result) => [result.sourceId, result.status]));
  return (registry.coverageGroups || []).map((group) => {
    const checkedIds = group.sourceIds.filter((sourceId) => statusById.has(sourceId));
    const availableIds = checkedIds.filter((sourceId) => statusById.get(sourceId) === 'healthy');
    const completeCheck = checkedIds.length === group.sourceIds.length;
    return {
      id: group.id,
      name: group.name,
      minimumAvailable: group.minimumAvailable,
      checkedCount: checkedIds.length,
      availableCount: availableIds.length,
      status: !completeCheck ? 'not-evaluated' : availableIds.length >= group.minimumAvailable ? 'available' : 'impaired'
    };
  });
}

async function collectSources(registry, options = {}) {
  const errors = validateRegistry(registry);
  if (errors.length > 0) throw new Error(`来源注册表无效：${errors.join(' ')}`);
  const selected = options.sourceIds && options.sourceIds.length > 0
    ? registry.sources.filter((source) => options.sourceIds.includes(source.id))
    : registry.sources.slice(0, options.limit || registry.sources.length);
  const concurrency = Math.max(1, Math.min(6, Number(options.concurrency) || 4));
  const results = new Array(selected.length);
  let cursor = 0;

  async function worker() {
    while (cursor < selected.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fetchSource(selected[index], options);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));
  const coverageGroups = auditCoverageGroups(registry, results);
  return {
    collectedAt: new Date().toISOString(),
    sourceCount: results.length,
    healthyCount: results.filter((result) => result.status === 'healthy').length,
    degradedCount: results.filter((result) => result.status === 'degraded').length,
    failedCount: results.filter((result) => result.status === 'failed').length,
    itemCount: results.reduce((total, result) => total + result.itemCount, 0),
    sources: results,
    coverageGroups
  };
}

module.exports = {
  collectSources,
  auditCoverageGroups,
  decodeEntities,
  fetchSource,
  fetchWithCurl,
  extractNearbyPublishedAt,
  isAllowedUrl,
  parseHtmlLinks,
  parseGithubTrending,
  parseJsonDiscovery,
  parseRssOrAtom,
  parseXApi,
  parseSourceContent,
  stripMarkup,
  validateRegistry,
  writeJsonAtomic
};
