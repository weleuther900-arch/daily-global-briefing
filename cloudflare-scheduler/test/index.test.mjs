import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchRequest, dispatchMorningBriefing, isWeeklyCaseExecution } from '../src/index.js';

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

test('北京时间周日06:00案例由 Cloudflare 派发，非该时刻不会创建请求', () => {
  const scheduled = Date.parse('2026-09-05T22:00:00Z');
  const request = createDispatchRequest(environment, '0 22 * * SAT', scheduled);
  assert.deepEqual(JSON.parse(request.init.body), {
    ref: 'main',
    inputs: { mode: 'case', allow_send: 'true', trigger_source: 'cloudflare-weekly-case' }
  });
  assert.equal(isWeeklyCaseExecution('0 22 * * SAT', scheduled), true);
  assert.equal(createDispatchRequest(environment, '0 22 * * SAT', Date.parse('2026-09-05T22:01:00Z')), null);
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

test('派发被拒时保留受限的 GitHub 错误摘要以便排错', async () => {
  await assert.rejects(
    dispatchMorningBriefing(environment, async () => ({
      ok: false,
      status: 403,
      text: async () => '{"message":"Resource not accessible by personal access token"}'
    })),
    /HTTP 403: \{"message":"Resource not accessible by personal access token"\}/
  );
});

test('缺少令牌或仓库格式错误时不会发起网络请求', () => {
  assert.throws(() => createDispatchRequest({ GITHUB_REPOSITORY: 'not a repo' }), /GITHUB_REPOSITORY/);
  assert.throws(() => createDispatchRequest({ GITHUB_REPOSITORY: environment.GITHUB_REPOSITORY }), /GITHUB_DISPATCH_TOKEN/);
});
