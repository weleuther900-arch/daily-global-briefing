'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {sync,mergeState}=require('../scripts/sync-private-history.cjs');
const root=()=>{fs.mkdirSync(path.resolve(__dirname,'../.runtime'),{recursive:true});return fs.mkdtempSync(path.resolve(__dirname,'../.runtime/history-test-'));};
test('durable state refuses public repositories before writing any state',async()=>{
 let calls=0;await assert.rejects(sync('save',{root:root(),repo:'owner/public',api:async()=>{calls++;return {private:false};}}),/只允许/);assert.equal(calls,1);
});
test('restored delivery success cannot be overwritten by a later unsent validation record',()=>{
 const result=mergeState('runs.json',{runs:[{runId:'case',sent:true,delivery:{smtpStatus:250},completedAt:'2026-09-20T12:00:00Z'}]},{runs:[{runId:'case',sent:false,completedAt:'2026-09-20T14:00:00Z'}]});
 assert.equal(result.runs[0].sent,true);
});
test('restore recovers indefinite history after cache loss and ignores unlisted snapshot paths',async()=>{
 const dir=root(),saved={version:1,files:{'editorial-history.json':{version:2,events:[{identity:'old',sentAt:'2020-01-01'}],thinking:[]},'../outside.json':{secret:'must not write'}}};
 await sync('restore',{root:dir,repo:'owner/private',api:async endpoint=>endpoint==='repos/owner/private'?{private:true}:{content:Buffer.from(JSON.stringify(saved)).toString('base64')}});
 const data=JSON.parse(fs.readFileSync(path.join(dir,'state/editorial-history.json'),'utf8'));assert.equal(data.events[0].identity,'old');assert.ok(!fs.existsSync(path.join(dir,'outside.json')));
});
test('save only serializes explicit history files and never raw output or fetched article caches',async()=>{
 const dir=root();fs.mkdirSync(path.join(dir,'state'));fs.writeFileSync(path.join(dir,'state/editorial-history.json'),JSON.stringify({version:2,events:[],thinking:[]}));fs.writeFileSync(path.join(dir,'state/weekly-case-ready.json'),JSON.stringify({content:'private raw draft'}));
 const calls=[];await sync('save',{root:dir,repo:'owner/private',api:async(endpoint,method,body)=>{
 calls.push({endpoint,method,body});if(endpoint==='repos/owner/private')return {private:true,default_branch:'main'};
 if(endpoint.includes('contents')&&method!=='PUT'){const e=Error('HTTP 404');throw e;}if(endpoint.includes('git/ref'))return {object:{sha:'base'}};return {content:{sha:'new'}};
 }});
 const write=calls.find(c=>c.method==='PUT');const snapshot=JSON.parse(Buffer.from(write.body.content,'base64'));assert.deepEqual(Object.keys(snapshot.files),['editorial-history.json']);assert.equal(write.body.branch,'runtime-state');
});
