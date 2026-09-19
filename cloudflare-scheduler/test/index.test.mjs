import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchRequest, dispatchMorningBriefing } from '../src/index.js';

const environment = {
  GITHUB_REPOSITORY: 'weleuther900-arch/daily-global-briefing-private',
  GITHUB_DISPATCH_TOKEN: 'test-token'
};

test('构造仅能触发正式晨报的 GitHub workflow_dispatch 请求', () => {
  const request = createDispatchRequest(environment);
  assert.equal(
    request.url,
    'https://api.github.com/repos/weleuther900-arch/daily-global-briefing-private/actions/workflows/daily-briefing.yml/dispatches'
  );
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(JSON.parse(request.init.body), {
    ref: 'main',
    inputs: { mode: 'final', allow_send: 'true', trigger_source: 'cloudflare-cron' }
  });
});

test('接受任意 2xx 的 GitHub workflow_dispatch 回执', async () => {
  let seen;
  const status = await dispatchMorningBriefing(environment, async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 204 };
  });
  assert.equal(status, 204);
  assert.equal(seen.init.headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('缺少令牌或仓库格式错误时不会发起网络请求', () => {
  assert.throws(() => createDispatchRequest({ GITHUB_REPOSITORY: 'not a repo' }), /GITHUB_REPOSITORY/);
  assert.throws(() => createDispatchRequest({ GITHUB_REPOSITORY: environment.GITHUB_REPOSITORY }), /GITHUB_DISPATCH_TOKEN/);
});
