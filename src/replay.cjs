'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getCoverageWindow } = require('./pipeline.cjs');

function locateSelectedBriefing(inputPath) {
  const target = path.resolve(inputPath);
  const candidates = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).filter((name) => /^briefing-\d{4}-\d{2}-\d{2}\.selected\.json$/.test(name)).map((name) => path.join(target, name))
    : [target];
  if (candidates.length !== 1) throw new Error('补发资料中必须恰好包含一份 briefing-YYYY-MM-DD.selected.json。');
  const selected = JSON.parse(fs.readFileSync(candidates[0], 'utf8'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(selected.briefingDate || '') || !Array.isArray(selected.events) || selected.events.length === 0) {
    throw new Error('补发资料缺少有效的晨报日期或事件内容。');
  }
  return { sourcePath: candidates[0], selected };
}

function replayResult(selected) {
  return {
    briefingDate: selected.briefingDate,
    window: getCoverageWindow(selected.briefingDate),
    events: selected.events,
    // 使用归档的原文，不调用模型补写或改写。
    thinking: selected.thinking || null
  };
}

module.exports = { locateSelectedBriefing, replayResult };
