'use strict';

// 榜单日期表示观察时点，不能伪装成项目发布日。仅接受 GitHub 自身的日/周榜。
function isTrendingObservation(item) {
  const observation = item && item.observation;
  if (!observation) return false;
  if (observation.kind === 'github-momentum') {
    if (observation.sourceUrl !== (observation.repositoryUrl || '').replace('https://github.com/', 'https://api.github.com/repos/')) return false;
    if (!observation.metrics?.qualifies || !observation.metrics.signals?.length) return false;
  } else if (observation.kind !== 'github-trending' || !['daily', 'weekly'].includes(observation.period)
    || observation.sourceUrl !== `https://github.com/trending?since=${observation.period}`) return false;
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(observation.repositoryUrl || '')) return false;
  if (!Number.isFinite(Date.parse(observation.observedAt)) || observation.observedAt !== item.publishedAt) return false;
  const repository = observation.repositoryUrl.replace(/\/$/, '');
  return [item.url, ...(item.sources || []).map((source) => source.url)]
    .some((url) => String(url || '').replace(/\/$/, '') === repository);
}

function withinEditorialWindow(item, window) {
  const timestamp = Date.parse(item && item.publishedAt);
  if (!Number.isFinite(timestamp) || timestamp < window.start.getTime()) return false;
  if (timestamp < window.end.getTime()) return true;
  // 07:05 最终扫描看到的榜单可以进入当期，但新闻窗口仍在07:00截止。
  return isTrendingObservation(item) && timestamp <= window.end.getTime() + 90 * 60 * 1000;
}

function eventTimeLabel(event) {
  if (!isTrendingObservation(event)) return '公开时间';
  if (event.observation.kind === 'github-momentum') return 'GitHub关注度观察时间（非项目发布日期）';
  return `GitHub${event.observation.period === 'weekly' ? '周' : '日'}榜观察时间（非项目发布日期）`;
}

module.exports = { eventTimeLabel, isTrendingObservation, withinEditorialWindow };
