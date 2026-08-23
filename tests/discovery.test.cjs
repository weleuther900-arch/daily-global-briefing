'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  auditCoverageGroups,
  fetchSource,
  extractNearbyPublishedAt,
  isAllowedUrl,
  parseGithubTrending,
  parseHtmlLinks,
  parseJsonDiscovery,
  parseRssOrAtom,
  parseXApi,
  validateRegistry
} = require('../src/discovery.cjs');

const registry = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config', 'sources.v1.json'), 'utf8'));

function source(type, overrides = {}) {
  return {
    id: `test-${type}`,
    name: '测试来源',
    topics: ['ai'],
    tier: 'S',
    kind: 'official',
    discovery: {
      type,
      url: 'https://example.com/index',
      allowedHosts: ['example.com'],
      linkPattern: '^https://example\\.com/news/.+',
      itemsPath: 'results',
      titleField: 'title',
      urlField: 'url',
      dateField: 'date',
      ...overrides
    }
  };
}

test('第一批真实来源注册表通过结构与域名检查', () => {
  assert.deepEqual(validateRegistry(registry), []);
  assert.ok(registry.sources.length >= 12);
});

test('域名白名单拒绝HTTP、相似域名和外部跳转', () => {
  assert.equal(isAllowedUrl('https://example.com/a', ['example.com']), true);
  assert.equal(isAllowedUrl('http://example.com/a', ['example.com']), false);
  assert.equal(isAllowedUrl('https://example.com.evil.test/a', ['example.com']), false);
  assert.equal(isAllowedUrl('https://evil.test/a', ['example.com']), false);
});

test('RSS与Atom解析标题、链接和发布时间', () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[模型正式发布]]></title><link>https://example.com/news/model</link><pubDate>Sun, 16 Aug 2026 06:30:00 GMT</pubDate><guid>a1</guid></item></channel></rss>`;
  const atom = `<feed><entry><title>研究结果发布</title><link href="https://example.com/news/research"/><updated>2026-08-16T12:00:00Z</updated><id>a2</id></entry></feed>`;
  const rssItems = parseRssOrAtom(rss, source('rss'));
  const atomItems = parseRssOrAtom(atom, source('rss'));
  assert.equal(rssItems[0].title, '模型正式发布');
  assert.equal(rssItems[0].publishedAt, '2026-08-16T06:30:00.000Z');
  assert.equal(atomItems[0].url, 'https://example.com/news/research');
});

test('HTML发现只保留规则与域名同时允许的链接', () => {
  const html = `<a href="/news/one"><span>正式更新一</span></a><a href="https://evil.test/news/two">外部链接</a><a href="/about">关于我们</a>`;
  const items = parseHtmlLinks(html, source('html'));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '正式更新一');
  assert.equal(items[0].url, 'https://example.com/news/one');
});

test('HTML发现排除栏目页并服从单来源数量上限', () => {
  const source = {
    id: 'site', name: '站点', tier: 'S', kind: 'official', topics: ['ai'],
    discovery: { type: 'html', url: 'https://example.com/news/', allowedHosts: ['example.com'], linkPattern: '^https://example\\.com/news/.+', excludeLinkPattern: '^https://example\\.com/news/?$', maxItems: 1 }
  };
  const html = '<a href="/news/">栏目</a><a href="/news/a">文章甲内容</a><a href="/news/b">文章乙内容</a>';
  const items = parseHtmlLinks(html, source);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.com/news/a');
});

test('HTML栏目页邻近日期用于详情抓取前的窗口预筛选', () => {
  const html = '<li><a href="/news/a">正式政策文件</a><span>2026年8月16日</span></li>';
  assert.equal(extractNearbyPublishedAt(html, html.indexOf('<a'), html.indexOf('</a>') + 4 - html.indexOf('<a')), '2026-08-16T04:00:00.000Z');
});

test('JSON API按照注册字段映射发现条目', () => {
  const payload = JSON.stringify({ results: [{ id: 'r1', title: '监管文件发布', url: 'https://example.com/news/rule', date: '2026-08-16' }] });
  const items = parseJsonDiscovery(payload, source('json'));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '监管文件发布');
  assert.equal(items[0].publishedAt, '2026-08-16T00:00:00.000Z');
});

test('GitHub热门页只提取仓库卡片并记录观察时间', () => {
  const source = { id: 'github-trending', name: 'GitHub热门', tier: 'B', kind: 'community-signal', topics: ['open-source-tech'], discovery: { type: 'github-trending', url: 'https://github.com/trending?since=daily', allowedHosts: ['github.com'], maxItems: 5 } };
  const html = '<a href="/login">Login</a><article class="Box-row"><h2><a href="/owner/project"> owner / project </a></h2></article>';
  const items = parseGithubTrending(html, source, new Date('2026-08-17T00:00:00Z'));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'owner/project');
  assert.equal(items[0].publishedAt, '2026-08-17T00:00:00.000Z');
});

test('X API只保留官方帖子的原文、时间与原始链接', () => {
  const xSource = { id: 'x-watch', name: 'X官方观察', tier: 'B', kind: 'official-social', topics: ['ai'], discovery: { type: 'x-api', url: 'https://api.x.com/2/tweets/search/recent', allowedHosts: ['api.x.com', 'x.com'], query: 'from:OpenAI', maxItems: 5 } };
  const payload = { data: [{ id: '123', author_id: '1', text: 'Official model release with technical details and availability information.', created_at: '2026-08-17T00:00:00Z' }], includes: { users: [{ id: '1', username: 'OpenAI' }] } };
  const items = parseXApi(payload, xSource);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://x.com/OpenAI/status/123');
  assert.match(items[0].prefetchedText, /Official model release/);
});

test('缺少X令牌时跳过可选X来源且不发起网络请求', async () => {
  const previous = process.env.X_BEARER_TOKEN;
  delete process.env.X_BEARER_TOKEN;
  const xSource = source('x-api', { url: 'https://api.x.com/2/tweets/search/recent', allowedHosts: ['api.x.com', 'x.com'], query: 'from:OpenAI' });
  const result = await fetchSource(xSource, { fetchImpl: async () => { throw new Error('不应调用'); } });
  assert.equal(result.status, 'skipped');
  if (previous === undefined) delete process.env.X_BEARER_TOKEN;
  else process.env.X_BEARER_TOKEN = previous;
});

test('入口可访问但当天没有匹配条目时保持健康', async () => {
  const result = await fetchSource(source('html'), {
    enableCurlFallback: false,
    fetchImpl: async () => ({
      url: 'https://example.com/index',
      status: 200,
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from('<html><body>没有匹配链接</body></html>')
    })
  });
  assert.equal(result.status, 'healthy');
  assert.equal(result.contentStatus, 'empty');
  assert.equal(result.itemCount, 0);
});

test('覆盖组只有健康来源达到下限时才可用', () => {
  const groups = auditCoverageGroups({
    coverageGroups: [{ id: 'g1', name: '测试覆盖', sourceIds: ['a', 'b'], minimumAvailable: 2 }]
  }, [
    { sourceId: 'a', status: 'healthy' },
    { sourceId: 'b', status: 'degraded' }
  ]);
  assert.equal(groups[0].status, 'impaired');
});
