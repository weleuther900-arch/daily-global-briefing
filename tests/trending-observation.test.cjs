'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseGithubTrending } = require('../src/discovery.cjs');
const { enrichDiscoveryItems } = require('../src/detail.cjs');
const { prepareModelCandidates, clusterCandidates } = require('../src/routing.cjs');
const { trimDiscoveryForWindow } = require('../src/runtime.cjs');
const { getCoverageWindow, validateEvent } = require('../src/pipeline.cjs');
const { normalizeGeneratedEvent } = require('../src/openai.cjs');
const { eventTimeLabel } = require('../src/observation.cjs');

const registry=JSON.parse(fs.readFileSync(path.join(__dirname,'../config/sources.v1.json'),'utf8'));
const source={...registry.sources.find(s=>s.id==='github-rising'),id:'github-trending',discovery:{type:'github-trending',url:'https://github.com/trending?since=weekly',allowedHosts:['github.com'],maxItems:25}};
registry.sources.push(source);
const html='<article class="Box-row"><h2><a href="/example/tool">example/tool</a></h2><p>A useful tool for documenting reproducible workflows.</p><span>1,234 stars this week</span></article>';

test('周榜在07:05最终扫描进入当期观察，日周榜同一仓库合并且时间仍可核查',async()=>{
  const items=parseGithubTrending(html,source,new Date('2026-09-22T23:05:00Z'));
  assert.equal(items[0].observation.period,'weekly');
  assert.match(items[0].prefetchedText,/本周/);
  const discovery={sources:[{items}]};
  const trimmed=trimDiscoveryForWindow(discovery,getCoverageWindow('2026-09-23'));
  assert.equal(trimmed.sources[0].items.length,1);
  const details=await enrichDiscoveryItems(trimmed,registry,{fetchImpl:()=>{throw Error('不得替换成仓库发布日期');}});
  const candidates=prepareModelCandidates(details,'2026-09-23');
  assert.equal(candidates.candidateCount,1);
  const candidate=candidates.candidates[0];
  const fixture=JSON.parse(fs.readFileSync(path.join(__dirname,'../examples/candidates.sample.json'),'utf8')).candidates[0];
  const event=normalizeGeneratedEvent({...fixture,category:candidate.category,publishedAt:candidate.publishedAt,sources:candidate.sources,criticalFacts:[{claim:'上榜观察',sourceUrls:[candidate.sources[0].url]}]},candidates);
  assert.equal(validateEvent(event,getCoverageWindow('2026-09-23')).length,0);
  assert.match(eventTimeLabel(event),/周榜观察时间（非项目发布日期）/);
  assert.equal(clusterCandidates([candidate,{...candidate,observation:{...candidate.observation,period:'daily'}}]).length,1);
});

test('非榜单新闻不能借用观察时间例外，08:30之后的观察也不放行',()=>{
  const items=parseGithubTrending(html,source,new Date('2026-09-23T01:00:00Z'));
  assert.equal(trimDiscoveryForWindow({sources:[{items}]},getCoverageWindow('2026-09-23')).sources[0].items.length,0);
  const normal={publishedAt:'2026-09-22T23:05:00Z',url:'https://example.com/news'};
  assert.equal(trimDiscoveryForWindow({sources:[{items:[normal]}]},getCoverageWindow('2026-09-23')).sources[0].items.length,0);
});
