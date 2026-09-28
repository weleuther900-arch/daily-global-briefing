'use strict';
const fs=require('node:fs');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {readJson}=require('../src/state.cjs');const {writeJsonAtomic}=require('../src/discovery.cjs');const {appendRunLog}=require('../src/run-log.cjs');
const FILES=['editorial-history.json','business-case-history.json','sent-events.json','runs.json','cost-ledger.json'];
const branch='runtime-state',remotePath='runtime/history.json';
function mergeRecords(remote,local,key){const records=new Map();for(const item of [...(remote[key] || []),...(local[key] || [])])records.set(JSON.stringify(item),item);return {...remote,...local,[key]:[...records.values()]};}
function mergeState(name,remote,local){
 if(name==='editorial-history.json')return {...mergeRecords(remote,local,'events'),thinking:mergeRecords(remote,local,'thinking').thinking};
 if(name==='business-case-history.json')return mergeRecords(remote,local,'cases');
 if(name==='runs.json'){
  const runs=new Map();for(const item of [...(remote.runs || []),...(local.runs || [])]){const prior=runs.get(item.runId);if(!prior || (!prior.sent && (item.sent || Date.parse(item.completedAt || 0)>=Date.parse(prior.completedAt || 0))))runs.set(item.runId,item);}return {runs:[...runs.values()]};
 }
 if(name==='cost-ledger.json')return mergeRecords(remote,local,'entries');
 return mergeRecords(remote,local,'events');
}
async function sync(mode,options={}){
 const root=options.root || path.resolve(__dirname,'..');const repo=options.repo || process.env.GITHUB_REPOSITORY;
 if(!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))throw Error('需要明确的GitHub仓库。');
 const api=options.api || ((endpoint,method='GET',body)=>JSON.parse(execFileSync('gh',['api',endpoint,...(method==='GET'?[]:['--method',method,'--input','-'])],{cwd:root,encoding:'utf8',windowsHide:true,input:body?JSON.stringify(body):undefined,stdio:['pipe','pipe','pipe']}).trim()));
 const meta=await api('repos/'+repo);if(meta.private!==true)throw Error('运行历史只允许持久化至私有仓库。');
 let remote;
 try{remote=await api('repos/'+repo+'/contents/'+remotePath+'?ref='+branch);}catch(e){if(!String(e.stderr || e.message).includes('404'))throw e;}
 if(remote && remote.encoding==='none'){const blob=await api('repos/'+repo+'/git/blobs/'+remote.sha);remote={...remote,content:blob.content};}
 const snapshot=remote?JSON.parse(Buffer.from(remote.content,'base64').toString('utf8')):{version:1,files:{}};
 if(snapshot.version!==1 || !snapshot.files)throw Error('远端历史格式不兼容。');
 const files={};
 for(const name of FILES){const file=path.join(root,'state',name),local=readJson(file,null),saved=snapshot.files[name];
  if(local || saved){files[name]=saved&&local?mergeState(name,saved,local):local || saved;if(mode==='restore')writeJsonAtomic(file,files[name]);}
 }
 if(mode==='save' && Object.keys(files).length){
  if(!remote){let ref;try{ref=await api('repos/'+repo+'/git/ref/heads/'+branch);}catch(e){if(!String(e.stderr || e.message).includes('404'))throw e;}
   if(!ref){const base=await api('repos/'+repo+'/git/ref/heads/'+meta.default_branch);await api('repos/'+repo+'/git/refs','POST',{ref:'refs/heads/'+branch,sha:base.object.sha});}
  }
  if(JSON.stringify(files)!==JSON.stringify(snapshot.files))await api('repos/'+repo+'/contents/'+remotePath,'PUT',{message:'Persist private briefing delivery and editorial history',branch,content:Buffer.from(JSON.stringify({version:1,files})).toString('base64'),...(remote?{sha:remote.sha}:{})});
 }
 appendRunLog(root,{event:'private-history-'+mode,files:Object.keys(files),repository:repo});return {mode,files:Object.keys(files)};
}
if(require.main===module){const mode=process.argv[2];if(!['save','restore'].includes(mode))throw Error('使用save或restore。');sync(mode).then(r=>console.log(JSON.stringify(r))).catch(e=>{appendRunLog(path.resolve(__dirname,'..'),{event:'private-history-error',mode,message:e.message});console.error(e.message);process.exitCode=1;});}
module.exports={sync,mergeState,FILES};
