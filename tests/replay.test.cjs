'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { locateSelectedBriefing, replayResult } = require('../src/replay.cjs');

test('补发仅使用已归档的选题，不生成模型内容', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dgb-replay-'));
  const source = path.join(directory, 'briefing-2026-08-27.selected.json');
  fs.writeFileSync(source, JSON.stringify({ briefingDate: '2026-08-27', events: [{ title: '已归档事件' }], thinking: { title: '已归档思考', context: '不应重新生成。' } }), 'utf8');
  const { selected } = locateSelectedBriefing(directory);
  const result = replayResult(selected);
  assert.equal(result.events[0].title, '已归档事件');
  assert.deepEqual(result.thinking, { title: '已归档思考', context: '不应重新生成。' });
  assert.match(result.window.label, /2026年08月26日 07:00/);
});
