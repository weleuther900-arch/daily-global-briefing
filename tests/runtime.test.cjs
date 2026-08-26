'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertPublishableEditorialResult } = require('../src/runtime.cjs');

test('部分内容被编辑校验拒绝时，保留合格内容继续生成', () => {
  const result = { events: [{ title: '合格事件' }], audit: { rejected: [{ title: '不合格事件', reasons: ['缺少来源'] }] } };
  assert.equal(assertPublishableEditorialResult(result), result);
});

test('编辑校验未留下任何合格内容时停止投递', () => {
  assert.throws(
    () => assertPublishableEditorialResult({ events: [], audit: { rejected: [{ title: '不合格事件', reasons: ['缺少来源'] }] } }),
    /未留下可投递内容（拒绝1条）/
  );
});
