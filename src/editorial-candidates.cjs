'use strict';
const path=require('node:path');
const {readJson}=require('./state.cjs');
const {writeJsonAtomic}=require('./discovery.cjs');
const {getCoverageWindow,canonicalizeUrl}=require('./pipeline.cjs');
const {withinEditorialWindow}=require('./observation.cjs');
const {routeCategory,detectHardExclusion,clusterCandidates,selectEvidenceExcerpt}=require('./routing.cjs');
const {previousCoverage,hash}=require('./editorial-history.cjs');

function planEditorialDiscovery(discovery,registry,stateDirectory,briefingDate,options={}) {
  const file=path.join(stateDirectory,'editorial-backlog.json');
  const previous=readJson(file,{items:[]});
  const byUrl=new Map((previous.items || []).map(item=>[canonicalizeUrl(item.url),item]));
  for(const source of discovery.sources || [])for(const item of source.items || []) {
    const key=canonicalizeUrl(item.url),old=byUrl.get(key);
    byUrl.set(key,{...old,...item,lastTriedAt:old?.lastTriedAt || null});
  }
  const allowed=new Map(registry.sources.map(s=>[s.id,s]));
  const window=getCoverageWindow(briefingDate);
  const eligible=[...byUrl.values()].filter(item=>allowed.has(item.sourceId) && (!item.publishedAt || Date.parse(item.publishedAt)<window.end.getTime() || withinEditorialWindow(item,window)));
  // 先看本期与未尝试线索，按来源轮转，避免某个大站挤掉其他来源。
  const priority=item=>(withinEditorialWindow(item,window)?100:0)+(item.editorialSeed?50:0)+(!item.lastTriedAt?20:0);
  eligible.sort((a,b)=>priority(b)-priority(a) || Date.parse(a.lastTriedAt || '1970-01-01')-Date.parse(b.lastTriedAt || '1970-01-01') || Date.parse(b.publishedAt || 0)-Date.parse(a.publishedAt || 0));
  const selected=[],perSource=new Map();
  for(let round=0;selected.length<(options.detailLimit ?? 140) && round<60;round++)for(const item of eligible) {
    if(selected.length>=(options.detailLimit ?? 140))break;
    if(selected.includes(item))continue;
    if((perSource.get(item.sourceId)||0)>round)continue;
    selected.push(item);perSource.set(item.sourceId,(perSource.get(item.sourceId)||0)+1);
  }
  const attemptedAt=new Date().toISOString();
  const selectedUrls=new Set(selected.map(i=>canonicalizeUrl(i.url)));
  for(const item of byUrl.values())if(selectedUrls.has(canonicalizeUrl(item.url)))item.lastTriedAt=attemptedAt;
  // 这里只存抓取线索，不丢掉原日期；背景不设年份限制。
  writeJsonAtomic(file,{version:2,updatedAt:attemptedAt,items:[...byUrl.values()]});
  return {...discovery,sources:registry.sources.map(source=>({sourceId:source.id,items:selected.filter(item=>item.sourceId===source.id)})),editorialAudit:{discovered:eligible.length,selectedForDetails:selected.length,deferredDetails:eligible.length-selected.length}};
}

function prepareEditorialCandidates(details,briefingDate,history) {
  const window=getCoverageWindow(briefingDate),accepted=[],rejected=[];
  for(const item of details.items || []) {
    const reasons=[];
    if(item.detailStatus!=='ready' || item.access!=='open')reasons.push('公开正文不可用');
    const timestamp=Date.parse(item.publishedAt);
    if(!Number.isFinite(timestamp))reasons.push('原始日期无法核实');
    if(timestamp>=window.end.getTime() && !withinEditorialWindow(item,window))reasons.push('未来或未到本期窗口的材料');
    if(item.originalDatePrecision==='day' && timestamp+86400000>window.start.getTime())reasons.push('原文仅提供日期，尚不能确认新动态时间窗口');
    if(item.observation && !withinEditorialWindow(item,window))reasons.push('热度观察已过本期窗口');
    const text=String(item.text || '');
    const exclusion=detectHardExclusion(`${item.title}\n${text}`);if(exclusion)reasons.push(exclusion);
    const [category,relevanceScore,directScore]=routeCategory({...item,text});
    if(directScore<1)reasons.push('没有商业或约定主题相关信号');
    const contentKind=item.observation?'observation':withinEditorialWindow(item,window)?'news':'background';
    const candidate={category,relevanceScore,title:item.title,originalTitle:item.title,publishedAt:item.publishedAt,originalDatePrecision:item.originalDatePrecision || null,contentKind,observation:item.observation || null,contentHash:hash(text),fingerprint:item.fingerprint,
      sources:[{sourceId:item.sourceId,organization:item.sourceName,title:item.title,url:item.url,tier:item.sourceTier,kind:item.sourceKind,access:item.access,isPrimary:item.sourceKind==='official' || item.sourceKind==='official-social',publishedAt:item.publishedAt,excerpt:selectEvidenceExcerpt(text,3000)}]};
    const prior=previousCoverage(candidate,history);
    if(prior) {
      const updated=contentKind!=='background' && candidate.contentHash!==prior.contentHash && (item.observation || timestamp>Date.parse(prior.publishedAt || 0));
      if(!updated)reasons.push('长期已刊记录中已有该内容');
      else candidate.priorCoverage={title:prior.title,publishedAt:prior.publishedAt,sentAt:prior.sentAt};
    }
    if(reasons.length)rejected.push({title:item.title,url:item.url,reasons});
    else accepted.push(candidate);
  }
  // 只把同一时间口径的内容聚类，旧背景不能借新报道刷新发布日期。
  const candidates=['news','observation','background'].flatMap(kind=>clusterCandidates(accepted.filter(c=>c.contentKind===kind)));
  return {briefingDate,editorialVersion:2,candidates,candidateCount:candidates.length,rejected,rejectedCount:rejected.length};
}

module.exports={planEditorialDiscovery,prepareEditorialCandidates};
