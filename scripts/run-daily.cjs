'use strict';

const path = require('node:path');
const { runDaily } = require('../src/runtime.cjs');

function parse(argv) {
  const options = { mode: 'final', send: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (['--date', '--mode', '--fixture'].includes(key)) options[key.slice(2).replace('fixture', 'fixturePath')] = argv[++index];
    else if (key === '--send') options.send = true;
    else if (key === '--validate-only') options.validateOnly = true;
    else throw new Error(`未知参数：${key}`);
  }
  if (!['scan', 'final', 'case'].includes(options.mode)) throw new Error('--mode只能是scan、final或case。');
  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const result = await runDaily({ ...options, root: path.resolve(__dirname, '..') });
  console.log(`RUN_OK id=${result.runId} status=${result.status} sent=${result.sent === true} events=${result.eventCount ?? 0} candidates=${result.candidateCount ?? 0}`);
}

main().catch((error) => { console.error(`RUN_FAILED ${error.message}`); process.exitCode = 1; });
