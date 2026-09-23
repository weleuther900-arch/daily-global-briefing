'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assessMomentum, collectGithubMomentum, parseStarHistory, parseTrendingMetrics } = require('../src/github-momentum.cjs');
const { enrichDiscoveryItems } = require('../src/detail.cjs');
const { prepareModelCandidates } = require('../src/routing.cjs');
const { eventTimeLabel } = require('../src/observation.cjs');
const registry = JSON.parse(fs.readFileSync(path.join(__dirname,'../config/sources.v1.json'),'utf8'));
const source = registry.sources.find(s=>s.id==='github-rising');
const now = '2026-09-22T23:05:00.000Z';
const point = (days,stars) => ({at:new Date(Date.parse(now)-days*86400000).toISOString(),stars});
const card = (name,stars,added,period='today') => `<article class="Box-row"><h2><a href="/${name}">${name}</a></h2><p>A tool that helps teams document repeatable workflow steps and share them.</p><a href="/${name}/stargazers">${stars}</a><span>${added} stars ${period}</span></article>`;
const response = content => ({ok:true,status:200,text:async()=>typeof content==='string'?content:JSON.stringify(content)});

test('解析平台近期新增与累计量，缩写值不冒充精确计数',()=>{
  const [record] = parseTrendingMetrics(card('org/tool','10,200','1,250'),'daily');
  assert.equal(record.stars,10200); assert.equal(record.reported.added,1250);
  assert.equal(parseTrendingMetrics(card('org/tool','10.2k','1,250'),'daily')[0].stars,null);
  assert.equal(parseTrendingMetrics(card('org/tool','10,200','1,250','this week'),'daily')[0].reported,null);
});

test('高累计量和高百分比小基数均不能自动入选；下降保留负数',()=>{
  assert.equal(assessMomentum({stars:100000,reported:[]},[],now).qualifies,false);
  assert.equal(assessMomentum({stars:10,reported:[]},[point(1,1)],now).qualifies,false);
  const result=assessMomentum({stars:98000,reported:[]},[point(1,100000)],now);
  assert.equal(result.daily.net,-2000); assert.equal(result.qualifies,false);
});

test('按真实时距计算净增，日周增长和加速必须分别有对应历史',()=>{
  const metrics=assessMomentum({stars:2000,reported:[]},[point(1,1500),point(2,1400),point(7,1000)],now);
  assert.equal(metrics.daily.net,500); assert.equal(metrics.weekly.net,1000);
  assert.equal(metrics.acceleration,5); assert.equal(metrics.historyStatus,'daily-and-weekly');
  const insufficient=assessMomentum({stars:2000,reported:[]},[point(0.1,1200),point(20,200)],now);
  assert.equal(insufficient.daily,null); assert.equal(insufficient.weekly,null); assert.equal(insufficient.qualifies,false);
});

test('冷启动可依平台新增发现热点，但不能声称已有历史增长率',()=>{
  const metrics=assessMomentum({stars:2000,reported:[{period:'daily',added:500,sourceUrl:'https://github.com/trending?since=daily'}]},[],now);
  assert.equal(metrics.qualifies,true); assert.equal(metrics.historyStatus,'insufficient');
  assert.equal(metrics.acceleration,null); assert.equal(metrics.daily,null);
});

test('搜索补充、连续快照、增长筛选和晨报候选贯通；历史写在指定缓存内',async()=>{
  const parent=path.join(__dirname,'../.runtime');fs.mkdirSync(parent,{recursive:true});
  const cache=fs.mkdtempSync(path.join(parent,'momentum-test-'));
  try {
    fs.writeFileSync(path.join(cache,'github-star-history.json'),JSON.stringify({version:1,repositories:{'org/hidden':{lastSeen:point(1,200).at,points:[point(1,200)]}}}));
    const fetchImpl=async url=>{
      if(url.includes('trending'))return response(card('org/hot','2,000','500',url.includes('weekly')?'this week':'today'));
      return response({items:[{full_name:'org/hidden',stargazers_count:450,description:'A practical tool for sharing reproducible business workflow documentation.'},{full_name:'org/large',stargazers_count:500000,description:'Large repository with unknown recent growth.'}]});
    };
    const result=await collectGithubMomentum(source,{cacheDirectory:cache,now,fetchImpl});
    assert.equal(result.itemCount,2);assert.equal(result.momentumAudit.searched,3);
    assert.equal(result.items.some(i=>i.title==='org/large'),false);
    const hidden=result.items.find(i=>i.title==='org/hidden');
    assert.equal(hidden.observation.metrics.daily.net,250);
    const saved=JSON.parse(fs.readFileSync(path.join(cache,'github-star-history.json'),'utf8'));
    assert.equal(saved.repositories['org/hidden'].points.length,2);
    const details=await enrichDiscoveryItems({sources:[result]},registry,{fetchImpl:async()=>{throw Error('不得丢失已采集的增长证据');}});
    const candidates=prepareModelCandidates(details,'2026-09-23');
    assert.equal(candidates.candidateCount,2);
    assert.match(eventTimeLabel({...hidden,sources:[{url:hidden.url}]}),/关注度观察时间/);
    // 同一小时重跑不增加观测数量。
    await collectGithubMomentum(source,{cacheDirectory:cache,now,fetchImpl});
    assert.equal(JSON.parse(fs.readFileSync(path.join(cache,'github-star-history.json'),'utf8')).repositories['org/hidden'].points.length,2);
  } finally { fs.rmSync(cache,{recursive:true,force:true}); }
});

test('离开榜单和搜索的项目继续观测；限流失败留下诊断且不冒充零增长',async()=>{
  const parent=path.join(__dirname,'../.runtime');fs.mkdirSync(parent,{recursive:true});
  const cache=fs.mkdtempSync(path.join(parent,'momentum-test-'));
  try {
    fs.writeFileSync(path.join(cache,'github-star-history.json'),JSON.stringify({version:1,repositories:{'org/away':{lastSeen:point(1,200).at,points:[point(1,200)]},'org/unavailable':{lastSeen:point(1,500).at,points:[point(1,500)]}}}));
    const fetchImpl=async url=>{
      if(url.endsWith('/org/away'))return response({full_name:'org/away',stargazers_count:500,description:'A repository with growth outside trending.'});
      if(url.endsWith('/org/unavailable'))return {ok:false,status:429};
      if(url.includes('trending'))return response(card('org/quiet','50','1',url.includes('weekly')?'this week':'today'));
      return response({items:[]});
    };
    const result=await collectGithubMomentum(source,{cacheDirectory:cache,now,fetchImpl});
    assert.equal(result.items[0].title,'org/away');
    assert.equal(result.momentumAudit.partialCoverage,true);
    assert.match(result.momentumAudit.failures[0].error,/429/);
    const saved=JSON.parse(fs.readFileSync(path.join(cache,'github-star-history.json'),'utf8'));
    assert.equal(saved.repositories['org/unavailable'].points.length,1);
  } finally { fs.rmSync(cache,{recursive:true,force:true}); }
});

test('所有入口失败明确标为失败，不生成热门项目',async()=>{
  const result=await collectGithubMomentum(source,{now,fetchImpl:async()=>({ok:false,status:403})});
  assert.equal(result.status,'failed');assert.equal(result.itemCount,0);assert.equal(result.momentumAudit.failures.length,4);
});

test('官方聚合历史支持未上榜项目冷启动，过期统计和不一致总数不作为近期热点',async()=>{
  const week=Date.parse('2026-09-20T00:00:00Z')/1000;
  assert.equal(parseStarHistory([{week:week-14*86400,total:99999,days:[99999,0,0,0,0,0,0]}],'org/old',now).length,0);
  assert.equal(parseStarHistory([{week,total:1000,days:[1,2,3,0,0,0,0]}],'org/bad',now).length,0);
  const result=await collectGithubMomentum(source,{now,fetchImpl:async url=>{
    if(url.includes('trending'))return {ok:false,status:503};
    if(url.includes('/stargazers/history'))return response([{week,total:180,days:[30,150,0,0,0,0,0]}]);
    if(url.endsWith('/readme'))return response({encoding:'base64',content:Buffer.from('A practical workflow tool with reproducible examples and deployment instructions.').toString('base64')});
    return response({items:[{full_name:'org/hidden',stargazers_count:300,description:'Workflow tool'}]});
  }});
  assert.equal(result.itemCount,1);assert.equal(result.momentumAudit.verifiedHistories,1);
  assert.equal(result.items[0].observation.metrics.daily,null);
  assert.ok(result.items[0].observation.metrics.signals.includes('github-history-recent-day'));
  assert.match(result.items[0].prefetchedText,/自然周可能尚未结束/);
  assert.match(result.items[0].prefetchedText,/reproducible examples/);
});
