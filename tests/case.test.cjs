'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { caseSchema, renderBusinessCase, renderBusinessCaseText } = require('../src/case.cjs');

const sample = {
  title: '企业扩张案例', subtitle: '定价、资本投入与现金回报',
  sections: Array.from({ length: 5 }, (_, index) => ({ title: `案例部分${index + 1}`, paragraphs: ['这是经来源支持的案例材料。', '本段列出经营变量和判断边界。'] })),
  decisionQuestions: [{ question: '企业是否应继续扩张？', variables: ['单位经济', '现金流'] }, { question: '定价如何调整？', variables: ['需求弹性', '竞争强度'] }, { question: '投入何时回收？', variables: ['资本开支', '利用率'] }],
  sources: [{ organization: '官方机构', title: '原始材料', url: 'https://example.com/source' }]
};

test('周日商业案例架构要求完整章节、决策问题和来源', () => {
  const schema = caseSchema();
  assert.equal(schema.properties.sections.minItems, 5);
  assert.equal(schema.properties.decisionQuestions.minItems, 3);
});

test('商业案例HTML和纯文本包含相同标题、问题和来源', () => {
  const html = renderBusinessCase(sample, '2026-08-23');
  const text = renderBusinessCaseText(sample, '2026-08-23');
  for (const value of ['企业扩张案例', '企业是否应继续扩张？', 'https://example.com/source']) {
    assert.match(html, new RegExp(value.replace(/[?]/g, '\\?')));
    assert.match(text, new RegExp(value.replace(/[?]/g, '\\?')));
  }
  assert.match(html, /prefers-color-scheme:dark/);
});
