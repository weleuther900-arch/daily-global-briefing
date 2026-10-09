const WORKFLOW_FILE = 'daily-briefing.yml';
const BRANCH = 'main';
const USER_AGENT = 'daily-global-briefing-cloudflare-scheduler';
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Cloudflare Workers uses SUN/1-7 for the weekday field (not the usual 0-6).
const WEEKLY_CASE_CRON = '0 22 * * SAT';

export function isWeeklyCaseExecution(cron, scheduledTime) {
  if (cron !== WEEKLY_CASE_CRON || !Number.isFinite(Number(scheduledTime))) return false;
  const beijing = new Date(Number(scheduledTime) + 8 * 60 * 60 * 1000);
  return beijing.getUTCDay() === 0 && beijing.getUTCHours() === 6 && beijing.getUTCMinutes() === 0;
}

function dispatchInputs(cron, scheduledTime) {
  if (cron === WEEKLY_CASE_CRON) {
    if (!isWeeklyCaseExecution(cron, scheduledTime)) return null;
    return { mode: 'case', allow_send: 'true', trigger_source: 'cloudflare-weekly-case' };
  }
  return { mode: 'final', allow_send: 'true', trigger_source: 'cloudflare-cron' };
}

export function createDispatchRequest(env, cron, scheduledTime) {
  const repository = String(env?.GITHUB_REPOSITORY || '').trim();
  const token = String(env?.GITHUB_DISPATCH_TOKEN || '').trim();
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be an owner/repository value.');
  }
  if (!token) {
    throw new Error('GITHUB_DISPATCH_TOKEN is not configured.');
  }

  const inputs = dispatchInputs(cron, scheduledTime);
  if (!inputs) return null;

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
        inputs
      })
    }
  };
}

export async function dispatchMorningBriefing(env, fetchImpl = fetch, cron, scheduledTime) {
  const request = createDispatchRequest(env, cron, scheduledTime);
  if (!request) return null;
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
    const status = await dispatchMorningBriefing(env, fetch, controller.cron, controller.scheduledTime);
    console.log(JSON.stringify({
      event: status ? 'github-workflow-dispatch-accepted' : 'schedule-time-mismatch',
      cron: controller.cron,
      status,
      scheduledTime: new Date(controller.scheduledTime).toISOString()
    }));
  },

  async fetch() {
    return new Response('Not found', { status: 404 });
  }
};
