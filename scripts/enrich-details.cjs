'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { enrichDiscoveryItems } = require('../src/detail.cjs');
const { writeJsonAtomic } = require('../src/discovery.cjs');

function parseArgs(argv) {
  const options = { registry: 'config/sources.v1.json', input: 'output/discovery-first-batch.json', output: 'output/details-latest.json', cache: '.cache/details', concurrency: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (['--registry', '--input', '--output', '--cache', '--limit', '--concurrency'].includes(key)) {
      options[key.slice(2)] = argv[++index];
    } else throw new Error(`未知参数：${key}`);
  }
  return options;
}

function localPath(projectRoot, value, label) {
  const resolved = path.resolve(projectRoot, value);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label}必须位于项目目录内。`);
  return resolved;
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const options = parseArgs(process.argv.slice(2));
  const registry = JSON.parse(fs.readFileSync(localPath(projectRoot, options.registry, '注册表'), 'utf8'));
  const discovery = JSON.parse(fs.readFileSync(localPath(projectRoot, options.input, '发现结果'), 'utf8'));
  const result = await enrichDiscoveryItems(discovery, registry, {
    cacheDirectory: localPath(projectRoot, options.cache, '详情缓存'),
    limit: options.limit ? Number(options.limit) : undefined,
    concurrency: Number(options.concurrency) || 4
  });
  const outputPath = localPath(projectRoot, options.output, '输出文件');
  writeJsonAtomic(outputPath, result);
  console.log(`DETAILS_OK items=${result.itemCount} ready=${result.readyCount} insufficient=${result.insufficientCount} failed=${result.failedCount} paid=${result.paidCount}`);
  console.log(`OUTPUT=${outputPath}`);
  if (result.failedCount > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`DETAILS_FAILED ${error.message}`);
  process.exitCode = 1;
});
