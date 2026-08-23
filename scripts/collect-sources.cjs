'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { collectSources, writeJsonAtomic } = require('../src/discovery.cjs');

function parseArguments(argv) {
  const options = {
    registry: 'config/sources.v1.json',
    cache: '.cache/discovery',
    output: 'output/discovery-latest.json',
    concurrency: 4
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (['--registry', '--cache', '--output', '--limit', '--sources', '--concurrency'].includes(key)) {
      options[key.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`未知参数：${key}`);
    }
  }
  return options;
}

function withinProject(targetPath, projectRoot, label) {
  const resolved = path.resolve(projectRoot, targetPath);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label}必须位于项目目录内。`);
  return resolved;
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const options = parseArguments(process.argv.slice(2));
  const registryPath = withinProject(options.registry, projectRoot, '来源注册表');
  const cacheDirectory = withinProject(options.cache, projectRoot, '缓存目录');
  const outputPath = withinProject(options.output, projectRoot, '输出文件');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const sourceIds = options.sources ? options.sources.split(',').map((value) => value.trim()).filter(Boolean) : null;
  const result = await collectSources(registry, {
    cacheDirectory,
    sourceIds,
    limit: options.limit ? Number(options.limit) : undefined,
    concurrency: Number(options.concurrency) || 4
  });
  writeJsonAtomic(outputPath, result);
  console.log(`DISCOVERY_OK sources=${result.sourceCount} healthy=${result.healthyCount} degraded=${result.degradedCount} failed=${result.failedCount} items=${result.itemCount}`);
  for (const source of result.sources) {
    const detail = source.status === 'healthy'
      ? `items=${source.itemCount} http=${source.httpStatus} cached=${source.cached} transport=${source.transport || 'fetch'}`
      : `error=${source.error}`;
    console.log(`${source.sourceId} ${source.status} ${detail}`);
  }
  for (const group of result.coverageGroups.filter((item) => item.status !== 'not-evaluated')) {
    console.log(`coverage:${group.id} ${group.status} available=${group.availableCount}/${group.minimumAvailable}`);
  }
  console.log(`OUTPUT=${outputPath}`);
  if (result.failedCount > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`DISCOVERY_FAILED ${error.message}`);
  process.exitCode = 1;
});
