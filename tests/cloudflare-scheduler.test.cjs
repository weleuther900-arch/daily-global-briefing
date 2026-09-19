'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const schedulerEntry = path.join(root, 'cloudflare-scheduler', 'src', 'index.js');
const schedulerUrl = pathToFileURL(schedulerEntry).href;

test('Cloudflare 调度器只派发正式晨报并带可审计来源标记', async () => {
  const { createDispatchRequest } = await import(schedulerUrl);
  const request = createDispatchRequest({
    GITHUB_REPOSITORY: 'weleuther900-arch/daily-global-briefing-private',
    GITHUB_DISPATCH_TOKEN: 'test-token'
  });
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers['User-Agent'], 'daily-global-briefing-cloudflare-scheduler');
  assert.deepEqual(JSON.parse(request.init.body).inputs, {
    mode: 'final',
    allow_send: 'true',
    trigger_source: 'cloudflare-cron'
  });
});

test('Cloudflare 为主触发，GitHub 在晨间窗口内保留一次无重复投递的兜底', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'daily-briefing.yml'), 'utf8');
  const config = fs.readFileSync(path.join(root, 'cloudflare-scheduler', 'wrangler.jsonc'), 'utf8');
  assert.doesNotMatch(workflow, /- cron: '0 19 \* \* \*'/);
  assert.doesNotMatch(workflow, /- cron: '5,20,35,50 23 \* \* \*'/);
  assert.match(workflow, /- cron: '50 23 \* \* \*'/);
  assert.match(workflow, /trigger_source=github-schedule-fallback/);
  assert.match(workflow, /require_morning_readiness=true/);
  assert.match(workflow, /trigger_source:/);
  assert.match(config, /"5 23 \* \* \*"/);
  assert.match(config, /"35 23 \* \* \*"/);
  assert.match(config, /"required"\s*:\s*\[\s*"GITHUB_DISPATCH_TOKEN"/);
});
