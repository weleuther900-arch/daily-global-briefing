'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertCaseReviewPassed, caseSchema, renderBusinessCase, renderBusinessCaseText } = require('../src/case.cjs');

const sample = {
  title: '企业扩张案例', subtitle: '企业是否应在需求尚未稳定时继续扩张？',
  sections: ['situation', 'decision', 'mechanism', 'outcome'].map((role) => ({ role, paragraphs: ['这是经来源支持的案例材料。', '本段只解释当前步骤需要的经营变量。'] })),
  decisionQuestions: [{ question: '企业是否应继续扩张？', variables: ['单位经济', '现金流'] }],
  sources: [{ organization: '官方机构', title: '原始材料', url: 'https://example.com/source' }]
};

test('周日商业案例固定为一条主线、四个步骤和一道问题', () => {
  const schema = caseSchema();
  assert.equal(schema.properties.sections.minItems, 4);
  assert.equal(schema.properties.sections.maxItems, 4);
  assert.equal(schema.properties.decisionQuestions.minItems, 1);
  assert.equal(schema.properties.decisionQuestions.maxItems, 1);
});

test('商业案例HTML和纯文本包含相同标题、问题和来源', () => {
  const html = renderBusinessCase(sample, '2026-08-23');
  const text = renderBusinessCaseText(sample, '2026-08-23');
  for (const value of ['企业扩张案例', '企业是否应继续扩张？', 'https://example.com/source']) {
    assert.match(html, new RegExp(value.replace(/[?]/g, '\\?')));
    assert.match(text, new RegExp(value.replace(/[?]/g, '\\?')));
  }
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /这篇只回答一个问题/);
  assert.match(text, /真正要解决的问题/);
});

test('商业案例审校拒绝时保留可诊断上下文并使用受控错误码', () => {
  assert.throws(
    () => assertCaseReviewPassed({ passed: false, issues: [{ severity: 'blocking', problem: '案例数字无法由材料支持。' }] }, [{ sources: [{ url: 'https://example.com/source' }] }]),
    (error) => {
      assert.equal(error.code, 'CASE_REVIEW_BLOCKED');
      assert.equal(error.context.review.issues[0].problem, '案例数字无法由材料支持。');
      assert.deepEqual(error.context.materialSourceUrls, ['https://example.com/source']);
      return true;
    }
  );
});
