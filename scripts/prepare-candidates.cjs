'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { prepareModelCandidates, filterPreviouslySent } = require('../src/routing.cjs');
const { writeJsonAtomic } = require('../src/discovery.cjs');

function args(argv) {
  const result = { input: 'output/details-latest.json', output: 'output/model-candidates.json', state: 'state/sent-events.json' };
  for (let index = 0; index < argv.length; index += 1) {
    if (['--input', '--output', '--state', '--date'].includes(argv[index])) result[argv[index].slice(2)] = argv[++index];
    else throw new Error(`未知参数：${argv[index]}`);
  }
  if (!result.date) throw new Error('必须提供--date YYYY-MM-DD。');
  return result;
}

function local(root, value) {
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('路径必须位于项目目录内。');
  return resolved;
}

function readJsonOr(pathname, fallback) {
  try { return JSON.parse(fs.readFileSync(pathname, 'utf8')); } catch { return fallback; }
}

function main() {
  const root = path.resolve(__dirname, '..');
  const options = args(process.argv.slice(2));
  const details = readJsonOr(local(root, options.input), null);
  if (!details) throw new Error('找不到详情输入文件。');
  const state = readJsonOr(local(root, options.state), { version: 1, events: [] });
  const result = filterPreviouslySent(prepareModelCandidates(details, options.date), state);
  const output = local(root, options.output);
  writeJsonAtomic(output, result);
  console.log(`CANDIDATES_OK candidates=${result.candidateCount} rejected=${result.rejectedCount} historicalDuplicates=${result.historicalDuplicates.length}`);
  console.log(`OUTPUT=${output}`);
}

try { main(); } catch (error) { console.error(`CANDIDATES_FAILED ${error.message}`); process.exitCode = 1; }
