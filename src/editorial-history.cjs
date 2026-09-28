'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('./state.cjs');
const { writeJsonAtomic } = require('./discovery.cjs');
const { canonicalizeUrl, canonicalizeTitle } = require('./pipeline.cjs');
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const urlsOf = item => (item.urls || (item.sources || []).map(s=>s.url)).map(canonicalizeUrl);

function loadEditorialHistory(stateDirectory) {
  const history = readJson(path.join(stateDirectory,'editorial-history.json'),{version:2,events:[],thinking:[],coverage:'known-records-only'});
  // 迁移已投递记录；不能把构建样例或未发送草稿登记为读过。
  const recent = readJson(path.join(stateDirectory,'sent-events.json'),{events:[]});
  for (const item of recent.events || []) if (!history.events.some(e=>e.fingerprint===item.fingerprint && e.sentAt===item.sentAt)) history.events.push({...item,urls:urlsOf(item)});
  return history;
}

function previousCoverage(candidate, history) {
  const urls = new Set(urlsOf(candidate));
  return [...(history.events || [])].sort((a,b)=>Date.parse(b.sentAt || 0)-Date.parse(a.sentAt || 0)).find(item => urlsOf(item).some(url=>urls.has(url))
    || (item.originalTitle && canonicalizeTitle(item.originalTitle)===canonicalizeTitle(candidate.title)));
}

function recordDeliveredEdition(stateDirectory, result, sentAt = new Date().toISOString()) {
  const history=loadEditorialHistory(stateDirectory);
  for (const event of result.events || []) {
    const identity=event.eventKey || event.fingerprint || hash(JSON.stringify(urlsOf(event)));
    if (!history.events.some(e=>e.identity===identity && e.edition===result.briefingDate)) history.events.push({identity,edition:result.briefingDate,fingerprint:event.fingerprint,title:event.title,originalTitle:event.originalTitle,urls:urlsOf(event),publishedAt:event.publishedAt,contentHash:event.contentHash || null,contentKind:event.contentKind || 'news',sentAt});
  }
  const t=result.thinking;
  if (t?.type && t.topicKey && !history.thinking.some(x=>x.edition===result.briefingDate)) history.thinking.push({edition:result.briefingDate,type:t.type,topicKey:t.topicKey,title:t.title,urls:urlsOf(t),sentAt});
  writeJsonAtomic(path.join(stateDirectory,'editorial-history.json'),{...history,updatedAt:sentAt});
  return history;
}

function recoverDeliveryHistory(root) {
  const stateDirectory=path.join(root,'state');
  const runs=readJson(path.join(stateDirectory,'runs.json'),{runs:[]});
  for (const run of runs.runs || []) {
    if (!run.sent || run.kind==='business-case' || !/^\d{4}-\d{2}-\d{2}$/.test(run.date || '')) continue;
    const artifact=path.join(root,'output',`briefing-${run.date}.selected.json`);
    if (fs.existsSync(artifact)) recordDeliveredEdition(stateDirectory,readJson(artifact,{}),run.delivery?.acceptedAt || run.completedAt);
  }
  return loadEditorialHistory(stateDirectory);
}

module.exports={hash,loadEditorialHistory,previousCoverage,recordDeliveredEdition,recoverDeliveryHistory,urlsOf};
