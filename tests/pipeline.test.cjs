'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalizeUrl,
  getCoverageWindow,
  jaccardSimilarity,
  runEditorialPipeline,
  validateEvent
} = require('../src/pipeline.cjs');
const { renderHtml, renderPlainText } = require('../src/render.cjs');

const samplePath = path.resolve(__dirname, '..', 'examples', 'candidates.sample.json');
const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));

test('覆盖窗口固定为北京时间前一日07:00至当日07:00', () => {
  const window = getCoverageWindow('2026-08-17');
  assert.equal(window.start.toISOString(), '2026-08-15T23:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-08-16T23:00:00.000Z');
});

test('链接规范化删除常见跟踪参数', () => {
  assert.equal(
    canonicalizeUrl('https://example.com/a/?utm_source=x&keep=1#part'),
    'https://example.com/a?keep=1'
  );
});

test('相似标题可以被识别', () => {
  const similarity = jaccardSimilarity('某公司正式发布人工智能开发平台', '某公司发布人工智能开发平台正式版本');
  assert.ok(similarity > 0.72);
});

test('付费来源和窗口外事件不能进入成稿', () => {
  const window = getCoverageWindow('2026-08-17');
  const event = structuredClone(sample.candidates[0]);
  event.publishedAt = '2026-08-17T08:00:00+08:00';
  event.sources[0].access = 'paid';
  const errors = validateEvent(event, window);
  assert.ok(errors.includes('公开时间不在本期二十四小时窗口内。'));
  assert.ok(errors.includes('包含付费或不可公开访问的来源。'));
});

test('样例管线完成筛选、事实绑定和去重', () => {
  const result = runEditorialPipeline(sample);
  assert.equal(result.audit.candidateCount, 5);
  assert.equal(result.audit.acceptedBeforeDedup, 3);
  assert.equal(result.audit.eventCount, 2);
  assert.equal(result.audit.rejected.length, 2);
  assert.equal(result.audit.duplicates.length, 1);
  assert.equal(result.events[0].category, 'ai');
  assert.equal(result.events[1].category, 'digital-economy');
  assert.match(result.events[0].fingerprint, /^[a-f0-9]{20}$/);
});

test('HTML与纯文本包含相同事件，且深色模式使用纯黑底色', () => {
  const result = runEditorialPipeline(sample);
  const html = renderHtml(result);
  const text = renderPlainText(result);
  for (const event of result.events) {
    assert.ok(html.includes(event.title));
    assert.ok(text.includes(event.title));
  }
  assert.ok(html.includes('@media (prefers-color-scheme:dark)'));
  assert.ok(html.includes('background:#000!important'));
  assert.ok(!html.includes('与项目设计方向一致'));
});
