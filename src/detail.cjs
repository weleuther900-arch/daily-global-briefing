'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fetchWithCurl, isAllowedUrl, stripMarkup, writeJsonAtomic } = require('./discovery.cjs');

const MAX_DETAIL_BYTES = 4 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 32000;

function firstMatch(content, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match && match[1]) return stripMarkup(match[1]);
  }
  return '';
}

function decodeJsonLdString(value) {
  try {
    return JSON.parse(`"${String(value).replaceAll('"', '\\"')}"`);
  } catch {
    return value;
  }
}

function extractTitle(html) {
  return firstMatch(html, [
    /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i,
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    /<title\b[^>]*>([\s\S]*?)<\/title>/i
  ]).replace(/\s*[|｜–—]\s*[^|｜–—]{2,40}$/, '').trim();
}

function extractPublishedAt(html) {
  const value = firstMatch(html, [
    /<meta\b[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']article:published_time["'][^>]*>/i,
    /<meta\b[^>]*name=["']date["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<time\b[^>]*datetime=["']([^"']+)["'][^>]*>/i,
    /["']datePublished["']\s*:\s*["']([^"']+)["']/i,
    /["']dateModified["']\s*:\s*["']([^"']+)["']/i
  ]);
  if (!value) return null;
  const date = new Date(decodeJsonLdString(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function extractCanonicalUrl(html, fallbackUrl) {
  const value = firstMatch(html, [
    /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i,
    /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i,
    /<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["'][^>]*>/i
  ]);
  try {
    return new URL(value || fallbackUrl, fallbackUrl).toString();
  } catch {
    return fallbackUrl;
  }
}

function extractLanguage(html) {
  const match = /<html\b[^>]*lang=["']([^"']+)["']/i.exec(html);
  return match ? match[1].toLowerCase() : null;
}

function removeNoise(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|canvas|form|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

function extractReadableText(html) {
  const cleaned = removeNoise(html);
  const article = firstMatchRaw(cleaned, [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<body\b[^>]*>([\s\S]*?)<\/body>/i
  ]) || cleaned;
  const blocks = [];
  for (const match of article.matchAll(/<(h1|h2|h3|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripMarkup(match[2]);
    if (text.length >= 20 && !blocks.includes(text)) blocks.push(text);
  }
  return blocks.join('\n\n').slice(0, MAX_EXTRACTED_CHARACTERS);
}

function firstMatchRaw(content, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(content);
    if (match && match[1]) return match[1];
  }
  return '';
}

function detectAccessState(html, text) {
  const sample = `${html.slice(0, 200000)}\n${text.slice(0, 10000)}`.toLowerCase();
  const paidSignals = [
    'subscribe to continue', 'subscriber-only', 'already a subscriber', 'unlock this article',
    '订阅后继续阅读', '付费阅读', '会员专享', '开通会员阅读全文'
  ];
  const registrationSignals = ['sign in to continue', 'register to continue', '登录后继续阅读', '注册后继续阅读'];
  if (paidSignals.some((signal) => sample.includes(signal))) return 'paid';
  if (registrationSignals.some((signal) => sample.includes(signal))) return 'registration';
  return 'open';
}

function detectUntrustedInstructions(text) {
  const sample = String(text).toLowerCase();
  const patterns = [
    /ignore (all|any|the) previous instructions/,
    /system prompt/,
    /developer message/,
    /请忽略.{0,12}(指令|规则)/,
    /输出.{0,8}(密码|密钥|令牌)/
  ];
  return patterns.some((pattern) => pattern.test(sample));
}

async function downloadDetail(item, source, options = {}) {
  if (!isAllowedUrl(item.url, source.discovery.allowedHosts)) throw new Error('详情链接不在来源域名白名单内。');
  const timeoutMs = options.timeoutMs || 20000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await (options.fetchImpl || globalThis.fetch)(item.url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
          'User-Agent': 'DailyGlobalBriefing/0.1'
        },
        redirect: 'follow',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!isAllowedUrl(response.url || item.url, source.discovery.allowedHosts)) throw new Error('详情重定向目标不在来源域名白名单内。');
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_DETAIL_BYTES) throw new Error('详情响应超过大小限制。');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_DETAIL_BYTES) throw new Error('详情响应超过大小限制。');
      return { html: buffer.toString('utf8'), finalUrl: response.url || item.url, status: response.status, transport: 'fetch' };
    } catch (error) {
      const useCurl = options.enableCurlFallback !== false &&
        (error.name === 'AbortError' || error.name === 'TypeError' || error.message === 'fetch failed' || /^HTTP (403|429|5\d\d)$/.test(error.message));
      if (!useCurl) throw error;
      const curl = await fetchWithCurl({ discovery: { url: item.url, allowedHosts: source.discovery.allowedHosts } }, timeoutMs);
      return { html: curl.content, finalUrl: curl.finalUrl, status: curl.status, transport: 'curl-fallback' };
    }
  } finally {
    clearTimeout(timeout);
  }
}

function extractDetail(item, source, html, finalUrl = item.url) {
  const title = extractTitle(html) || item.title;
  const publishedAt = extractPublishedAt(html) || item.publishedAt || null;
  const text = extractReadableText(html);
  const canonicalUrl = extractCanonicalUrl(html, finalUrl);
  const access = detectAccessState(html, text);
  return {
    ...item,
    title,
    url: canonicalUrl,
    publishedAt,
    language: extractLanguage(html),
    access,
    text,
    textHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 24),
    characterCount: text.length,
    hasUntrustedInstructions: detectUntrustedInstructions(text),
    detailStatus: title && text.length >= 120 ? 'ready' : 'insufficient'
  };
}

function readFreshCache(cachePath, maxAgeHours) {
  try {
    const value = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const age = Date.now() - new Date(value.cachedAt).getTime();
    return age >= 0 && age <= maxAgeHours * 60 * 60 * 1000 ? value.detail : null;
  } catch {
    return null;
  }
}

async function enrichDiscoveryItems(discoveryResult, registry, options = {}) {
  const sourceById = new Map(registry.sources.map((source) => [source.id, source]));
  const items = discoveryResult.sources.flatMap((source) => source.items || []);
  const selected = options.limit ? items.slice(0, options.limit) : items;
  const results = new Array(selected.length);
  const concurrency = Math.max(1, Math.min(6, options.concurrency || 4));
  let cursor = 0;

  async function worker() {
    while (cursor < selected.length) {
      const index = cursor++;
      const item = selected[index];
      const source = sourceById.get(item.sourceId);
      if (!source) {
        results[index] = { ...item, detailStatus: 'failed', error: '来源注册表中不存在该来源。' };
        continue;
      }
      if (item.prefetchedText) {
        const text = String(item.prefetchedText).trim();
        results[index] = {
          ...item,
          language: item.prefetchedLanguage || 'und',
          access: 'open',
          text,
          textHash: crypto.createHash('sha256').update(text).digest('hex').slice(0, 24),
          characterCount: text.length,
          hasUntrustedInstructions: detectUntrustedInstructions(text),
          detailStatus: text.length >= 60 ? 'ready' : 'insufficient',
          transport: item.prefetchedTransport || 'prefetched',
          httpStatus: 200,
          detailCached: false
        };
        continue;
      }
      const cachePath = options.cacheDirectory ? path.join(options.cacheDirectory, `${item.fingerprint}.json`) : null;
      const cached = cachePath ? readFreshCache(cachePath, options.cacheMaxAgeHours || 24) : null;
      if (cached) {
        results[index] = { ...cached, detailCached: true };
        continue;
      }
      try {
        const downloaded = await downloadDetail(item, source, options);
        const detail = {
          ...extractDetail(item, source, downloaded.html, downloaded.finalUrl),
          transport: downloaded.transport,
          httpStatus: downloaded.status,
          detailCached: false
        };
        if (cachePath) writeJsonAtomic(cachePath, { cachedAt: new Date().toISOString(), detail });
        results[index] = detail;
      } catch (error) {
        results[index] = { ...item, detailStatus: 'failed', error: error.message, text: '' };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, () => worker()));
  return {
    enrichedAt: new Date().toISOString(),
    itemCount: results.length,
    readyCount: results.filter((item) => item.detailStatus === 'ready').length,
    insufficientCount: results.filter((item) => item.detailStatus === 'insufficient').length,
    failedCount: results.filter((item) => item.detailStatus === 'failed').length,
    paidCount: results.filter((item) => item.access === 'paid').length,
    items: results
  };
}

module.exports = {
  detectAccessState,
  detectUntrustedInstructions,
  downloadDetail,
  enrichDiscoveryItems,
  extractCanonicalUrl,
  extractDetail,
  extractLanguage,
  extractPublishedAt,
  extractReadableText,
  extractTitle
};
