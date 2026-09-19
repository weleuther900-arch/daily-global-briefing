const WORKFLOW_FILE = 'daily-briefing.yml';
const BRANCH = 'main';
const USER_AGENT = 'daily-global-briefing-cloudflare-scheduler';
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function createDispatchRequest(env) {
  const repository = String(env?.GITHUB_REPOSITORY || '').trim();
  const token = String(env?.GITHUB_DISPATCH_TOKEN || '').trim();
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be an owner/repository value.');
  }
  if (!token) {
    throw new Error('GITHUB_DISPATCH_TOKEN is not configured.');
  }

  return {
    url: `https://api.github.com/repos/${repository}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({
        ref: BRANCH,
        inputs: {
          mode: 'final',
          allow_send: 'true',
          trigger_source: 'cloudflare-cron'
        }
      })
    }
  };
}

export async function dispatchMorningBriefing(env, fetchImpl = fetch) {
  const request = createDispatchRequest(env);
  const response = await fetchImpl(request.url, request.init);
  if (!response.ok) {
    const details = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 300);
    const suffix = details ? `: ${details}` : '';
    throw new Error(`GitHub workflow dispatch failed with HTTP ${response.status}${suffix}`);
  }
  return response.status;
}

export default {
  async scheduled(controller, env) {
    const status = await dispatchMorningBriefing(env);
    console.log(JSON.stringify({
      event: 'github-workflow-dispatch-accepted',
      cron: controller.cron,
      status,
      scheduledTime: new Date(controller.scheduledTime).toISOString()
    }));
  },

  async fetch() {
    return new Response('Not found', { status: 404 });
  }
};
