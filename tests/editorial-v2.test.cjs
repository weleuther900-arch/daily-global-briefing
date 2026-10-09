'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {applyBackgroundPolicy,eventIssues,generateEdition,screeningIssues,selectGenerationPool}=require('../src/editorial-engine.cjs');
const {generateThinking,nextThinkingType,thinkingIssues}=require('../src/business-thinking.cjs');
const {prepareEditorialCandidates,planEditorialDiscovery}=require('../src/editorial-candidates.cjs');
const {recordDeliveredEdition,loadEditorialHistory,previousCoverage}=require('../src/editorial-history.cjs');
const {runEditorialPipeline}=require('../src/pipeline.cjs');
const {renderHtml,renderPlainText}=require('../src/render.cjs');
const {runDaily,nextCaseSector,weeklyCaseFallbackSourceIds,getImpairedCoverageGroups}=require('../src/runtime.cjs');
const {parseSourceContent,collectSources}=require('../src/discovery.cjs');
const {replayResult}=require('../src/replay.cjs');
const date='2026-09-28',now=new Date('2026-09-27T23:10:00Z');
const temp=()=>{fs.mkdirSync(path.resolve(__dirname,'../.runtime'),{recursive:true});return fs.mkdtempSync(path.join(path.resolve(__dirname,'../.runtime'),'v2-test-'));};
const names=['云服务订阅涨价','芯片公司财报','开源项目维护成本','软件平台收入变化','开发者社区付费转型','数字支付跨境扩张'];
const proof='The company reported software subscription revenue growth and improved customer retention.';
function candidate(i=0){return {category:'digital-economy',title:names[i] || '独立材料'+i,publishedAt:'2026-09-27T13:00:00Z',contentKind:'news',relevanceScore:3,contentHash:'content-'+i,sources:[{sourceId:'official',organization:'原始披露',title:'经营数据',url:'https://example.com/story/'+i,tier:'S',kind:'official',isPrimary:true,access:'open',excerpt:proof}]};}
function decision(c){return {id:c.id,include:true,topic:'business',admission:'material-change',evidenceQuote:proof,evidenceUrl:c.sources[0].url,relevance:'数字商业经营变化',reason:'解释经营机制',backgroundValue:'仍有适用价值',followUpNovelty:'新增经营数据',importance:8};}
function draft(c,brief=false){return {title:c.title,conclusion:'公司披露订阅业务收入继续增长，并表示客户续费情况较上一阶段改善；这说明经营变化已经发生，但披露没有给出完整客户分层。',plainLanguage:brief?'':'订阅业务是客户按月或按年持续付费使用服务，公司需要不断交付价值才能维持续费。',impact:'如果续费改善来自真实使用增加，并且获客和服务成本没有同步上升，收入会更稳定，经营现金流也可能改善；若只是折扣或合同周期带来的短期变化，这种改善就难以持续。',judgmentBoundary:'以上属于公司披露，材料没有给出不同客户群的续费率、获客成本或服务成本，因此不能据此推断下一期利润，也不能确认它已经形成长期趋势。',sections:brief?[]:[{title:'关键细节',paragraphs:['材料同时说明收入与留存发生变化，但没有披露价格调整、客户数量和单个客户贡献，后续需要用这些数据判断增长来自客户增多、价格提高还是老客户留下。']}],availability:'不适用',evidenceBasis:'公司自报',backgroundReason:'帮助理解数字商业的经营机制',sources:c.sources.map(({organization,title,url})=>({organization,title,url})),criticalFacts:[{claim:'公司披露经营变化',sourceUrls:[c.sources[0].url]}]};}
function thoughtDraft(source,type='lesson'){return {type,lens:type==='lesson'?'switching-cost':'unit-economics',topicKey:type==='lesson'?'转换成本与续费':'订阅业务单位经济',title:type==='lesson'?'客户续费，未必只是因为满意':'订阅收入增长后，利润为什么可能没有同步增长',conclusion:type==='lesson'?'续费率只有与使用深度、价格变化和迁移成本一起看，才能判断客户留下是因为产品价值，还是因为离开太麻烦。':'订阅业务能否成为好生意，关键不在收入是否增长，而在每增加一元经常性收入需要付出多少获客和服务成本。',paragraphs:['转换成本包括数据迁移、员工重新学习和业务中断风险。它会让不满意的客户也暂时续费，因此高续费率不能单独证明产品体验优秀；若价格上调后使用深度仍提高，价值解释才更有说服力。这类锁定效应能保护收入，却也可能掩盖产品正在失去吸引力。','材料只确认订阅收入与留存发生变化，没有给出客户分层、价格调整或迁移数据。编辑判断是：下一步应把留存拆成主动使用与被动留下，否则公司可能误把退出困难当成产品竞争力。如果公司只奖励续费而不看实际使用，产品团队就可能把资源投向错误方向，甚至延误真正需要的改进。'],question:'如果使用量下降但续费率稳定，你会怎样解释这组数据？',variables:type==='lesson'?[]:['获客成本','服务成本','客户续费贡献'],limits:'结论只用于解释经营机制；材料没有提供客户分层，不能判断具体公司的长期利润。',sources:source.sources,criticalFacts:[{claim:'材料确认订阅收入与客户留存发生变化。',sourceUrls:[source.sources[0].url]}]};}
function caller(overrides={}){return async opts=>{
 const input=JSON.parse(opts.userPrompt);
 if(overrides[opts.schemaName])return {parsed:await overrides[opts.schemaName](input,opts)};
 if(opts.schemaName==='editorial_selection_v2')return {parsed:{decisions:input.map(decision)}};
 if(opts.schemaName==='editorial_event_v2')return {parsed:draft(input.candidate,opts.systemPrompt.includes('简讯：'))};
 return {parsed:{passed:true,issues:[]}};
};}
const edition=async(candidates,options={})=>generateEdition({briefingDate:date,candidates},{callStructured:caller(),...options});

test('v2 retains more than four qualified stories in one category and renders two features plus briefs',async()=>{
 const generated=await edition(names.map((_,i)=>candidate(i)));
 const result=runEditorialPipeline(generated.briefing);
 assert.equal(result.events.length,6);assert.equal(result.events.filter(e=>e.format==='feature').length,2);
 assert.equal(result.events.filter(e=>e.format==='brief'&&e.sections.length===0).length,4);
 assert.match(renderHtml(result),/简讯/);assert.match(renderPlainText(result),/简讯/);assert.match(renderHtml(result),/关键细节/);
 assert.equal(result.thinking,null);assert.doesNotMatch(renderPlainText(result),/二选一|先做可逆决策/);
});

test('qualified fast-rising GitHub projects keep reserved generation slots',()=>{
 const ordinary=Array.from({length:6},(_,i)=>({...candidate(i),id:`ordinary-${i}`,selection:{importance:9}}));
 const rising=[0,1,2].map(i=>({...candidate(i),id:`rising-${i}`,title:`repo-${i}`,observation:{kind:'github-momentum'},selection:{importance:5}}));
 const pool=selectGenerationPool([...ordinary,...rising],4,3);
 assert.deepEqual(pool.map(item=>item.id),['rising-0','rising-1','rising-2','ordinary-0']);
});

test('attention OR actual usage admits an early product; a bare launch or invented quote does not',()=>{
 const c=candidate();const media={...c,sources:[{...c.sources[0],kind:'media',isPrimary:false}]};const d={...decision(media),evidenceUrl:media.sources[0].url,topic:'product',admission:'attention'};
 assert.deepEqual(screeningIssues(media,d),[]);assert.deepEqual(screeningIssues(c,{...decision(c),topic:'product',admission:'usage'}),[]);
 assert.ok(screeningIssues(c,{...d,admission:'material-change'}).length);
 assert.ok(screeningIssues(c,{...d,evidenceQuote:'A fabricated record of ten million users'}).length);
 const bareQuote='The company officially launched the product.';const bare={...c,sources:[{...c.sources[0],excerpt:bareQuote}]};
 assert.match(screeningIssues(bare,{...decision(bare),topic:'product',admission:'attention',evidenceQuote:bareQuote})[0],/官方发布/);
 assert.match(screeningIssues(bare,{...decision(bare),topic:'product',admission:'usage',evidenceQuote:bareQuote})[0],/使用依据/);
});

test('background is recent, clearly labelled, and never repeats known coverage',async()=>{
 const detail={sourceId:'official',sourceName:'官方',sourceTier:'S',sourceKind:'official',url:'https://example.com/old',title:'Software business case',publishedAt:'2020-01-01T00:00:00Z',text:proof,access:'open',detailStatus:'ready'};
 const prepared=prepareEditorialCandidates({items:[detail,{...detail,url:detail.url+'/future',publishedAt:'2027-01-01'},{...detail,url:detail.url+'/unknown',publishedAt:null}]},date,{events:[]});
 assert.equal(prepared.candidateCount,0);assert.equal(prepared.rejectedCount,3);assert.match(prepared.rejected[0].reasons.join(' '),/背景原始日期超过30天/);
 const recent={...detail,url:'https://example.com/recent',publishedAt:'2026-09-01T00:00:00Z'};
 const recentPrepared=prepareEditorialCandidates({items:[recent]},date,{events:[]});assert.equal(recentPrepared.candidateCount,1);assert.equal(recentPrepared.candidates[0].contentKind,'background');
 const result=runEditorialPipeline((await edition(recentPrepared.candidates)).briefing);
 assert.equal(result.events.length,1);assert.match(renderHtml(result),/背景补充/);
 const state=temp();recordDeliveredEdition(state,result);
 assert.equal(prepareEditorialCandidates({items:[recent]},date,loadEditorialHistory(state)).candidateCount,0);
});

test('fresh items suppress background in a busy edition and briefs stay scannable',()=>{
 const selected=[...Array.from({length:5},(_,index)=>({...candidate(index),id:`news-${index}`,selection:{importance:7}})),...Array.from({length:2},(_,index)=>({...candidate(index+5),id:`background-${index}`,publishedAt:`2026-09-0${index+1}T00:00:00Z`,contentKind:'background',selection:{importance:8}}))];
 const audit={deferred:[]};const retained=applyBackgroundPolicy(selected,audit);
 assert.equal(retained.length,5);assert.equal(audit.deferred.filter(item=>item.reason==='background-held-for-quiet-day').length,2);
 assert.match(eventIssues({...draft(candidate(),true),conclusion:'x'.repeat(481)},candidate(),'brief').join(' '),/简讯正文超过480个字符/);
 assert.match(eventIssues({...draft(candidate(),true),plainLanguage:draft(candidate(),true).conclusion},candidate(),'brief').join(' '),/名词解释只是换词复述结论/);
 assert.match(eventIssues({...draft(candidate()),sections:[{title:'太长',paragraphs:['x'.repeat(851)]}]},candidate(),'feature').join(' '),/重点稿正文超过850个字符/);
 assert.match(eventIssues({...draft(candidate()),sections:[{title:'重复',paragraphs:[draft(candidate()).conclusion]}]},candidate(),'feature').join(' '),/关键细节.*重复/);
});

test('same-day observed GitHub popularity does not become old background after its observation window',()=>{
 const item={sourceId:'github-rising',sourceName:'GitHub',sourceTier:'S',sourceKind:'official',title:'repo/project',url:'https://github.com/repo/project',publishedAt:'2026-09-20T00:00:00Z',text:proof,access:'open',detailStatus:'ready',observation:{kind:'github-momentum',observedAt:'2026-09-20T00:00:00Z'}};
 assert.equal(prepareEditorialCandidates({items:[item]},date,{events:[]}).candidateCount,0);
});

test('independent review false with no issues still blocks after one repair',async()=>{
 let reviews=0;const result=await edition([candidate()],{callStructured:caller({editorial_review_v2:()=>{reviews++;return {passed:false,issues:[]};}})});
 assert.equal(reviews,2);assert.equal(result.briefing.candidates.length,0);
});

test('budget interruption retains reviewed output and explicitly defers remaining stories',async()=>{
 let generated=0,checkpoint;
 const result=await edition([candidate(0),candidate(1)],{onCheckpoint:p=>checkpoint=p,callStructured:caller({editorial_event_v2:(input,opts)=>{
 if(generated++>0){const error=Error('budget');error.code='MONTHLY_BUDGET_EXCEEDED';throw error;}return draft(input.candidate,false);
 }})});
 assert.equal(result.briefing.candidates.length,1);assert.equal(checkpoint.events.length,1);
 assert.equal(result.review.resourceStop,'MONTHLY_BUDGET_EXCEEDED');assert.equal(result.review.deferred.length,1);
});

test('thinking uses a separate material pool and rotates only after a delivered edition is recorded',async()=>{
 const state=temp(),history=loadEditorialHistory(state),news=candidate(0),independent={...candidate(1),contentKind:'background'};
 let chosen;
 const result=await generateThinking([news,independent],history,{newsUrls:[news.sources[0].url],callStructured:async opts=>{
 if(opts.schemaName==='business_thinking_review_v3')return {parsed:{passed:true,issues:[]}};
 const input=JSON.parse(opts.userPrompt);chosen=input.materials[0];return {parsed:thoughtDraft(chosen)};
 }});
 assert.equal(chosen.title,independent.title);assert.equal(result.thinking.reviewed,true);
 assert.equal(nextThinkingType(loadEditorialHistory(state)),'lesson');
 recordDeliveredEdition(state,{briefingDate:date,events:[],thinking:result.thinking});
 assert.equal(nextThinkingType(loadEditorialHistory(state)),'teardown');
 assert.equal(loadEditorialHistory(state).thinking[0].lens,'switching-cost');
 assert.match(loadEditorialHistory(state).thinking[0].conclusion,/续费率/);
 assert.match(renderPlainText(runEditorialPipeline({editorialVersion:2,briefingDate:date,candidates:[],thinking:result.thinking})),/客户续费，未必只是因为满意/);
});

test('thinking is not withheld when review text explicitly says the draft is accurate',async()=>{
 const source=candidate(0);let reviewCalls=0;
 const result=await generateThinking([source],{thinking:[]},{callStructured:async opts=>{
  if(opts.schemaName==='business_thinking_review_v3'){
   reviewCalls++;
   return {parsed:{passed:false,issues:[{severity:'blocking',problem:'The draft matches the source and is accurate. No issue here.'}]}};
  }
  return {parsed:thoughtDraft(source)};
 }});
 assert.equal(reviewCalls,1);assert.equal(result.audit.status,'passed');assert.equal(result.thinking.reviewed,true);
});

test('thinking keeps a locally distinct mechanism when review only asserts an unquoted historical repeat',async()=>{
 const source=candidate(0);let reviewCalls=0;
 const result=await generateThinking([source],{thinking:[]},{callStructured:async opts=>{
  if(opts.schemaName==='business_thinking_review_v3'){
   reviewCalls++;
   return {parsed:{passed:false,issues:[{severity:'blocking',problem:'这篇稿件与历史栏目内在观点重复，仍是通用的试点验证框架。'}]}};
  }
  return {parsed:thoughtDraft(source)};
 }});
 assert.equal(reviewCalls,1);assert.equal(result.audit.status,'passed');assert.equal(result.thinking.reviewed,true);
});

test('thinking refuses a generic fallback after three blocked drafts',async()=>{
 const source=candidate(0);const result=await generateThinking([source],{thinking:[]},{callStructured:async opts=>{
  if(opts.schemaName==='business_thinking_v3')return {parsed:{type:'lesson',lens:'customer-value',topicKey:'x',title:'x',conclusion:'',paragraphs:[],question:'',variables:[],limits:'',sources:[],criticalFacts:[]}};
  throw Error('invalid draft should not reach review');
 }});
 assert.equal(result.audit.status,'review-blocked');assert.equal(result.thinking,null);assert.equal(result.audit.attempts.length,3);assert.match(result.audit.reason,/拒绝用换标题/);
});

test('thinking rejects the old trial-and-metrics core and recently used semantic lens',()=>{
 const source=candidate(0),draft={...thoughtDraft(source),lens:'customer-value',conclusion:'先做一个小范围试点，再看真实使用频率和错误率，最后决定要不要扩大投入。'};
 const issues=thinkingIssues(draft,[source],{thinking:[{lens:'customer-value',topicKey:'其他标题',title:'表面不同',conclusion:'另一种说法',sentAt:'2026-09-27T00:00:00Z'}]},'lesson');
 assert.match(issues.join(' '),/同一商业机制分类/);assert.match(issues.join(' '),/通用的试点验证框架/);
 const specific=thoughtDraft(source),semanticIssues=thinkingIssues(specific,[source],{thinking:[{lens:'pricing',topicKey:'不同机制名',title:'完全不同的标题',conclusion:specific.conclusion,sentAt:'2026-09-27T00:00:00Z'}]},'lesson');
 assert.match(semanticIssues.join(' '),/核心结论重复/);
});

test('screening backlog survives scans without being marked attempted or losing original dates',()=>{
 const state=temp(),item={sourceId:'official',url:'https://example.com/old',title:'Old software case',publishedAt:'2019-01-01T00:00:00Z'};
 const registry={sources:[{id:'official'}]};planEditorialDiscovery({sources:[{items:[item]}]},registry,state,date,{detailLimit:0});
 const later=planEditorialDiscovery({sources:[]},registry,state,date,{detailLimit:1});
 assert.equal(later.sources[0].items[0].publishedAt,item.publishedAt);
});

test('sitemap discovers article URLs without misusing sitemap lastmod as publication time',()=>{
 const source={id:'official',name:'Official',tier:'S',kind:'official',topics:['ai'],discovery:{type:'sitemap',allowedHosts:['example.com'],linkPattern:'^https://example.com/blog/.+'}};
 const items=parseSourceContent('<urlset><url><loc>https://example.com/blog</loc></url><url><loc>https://example.com/blog/new-model</loc><lastmod>2026-09-28</lastmod></url></urlset>',source);
 assert.equal(items.length,1);assert.equal(items[0].publishedAt,null);
});

test('weekly sector alternation follows delivery history and has registered traditional sources',()=>{
 const registry=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../config/sources.v1.json'),'utf8'));
 assert.equal(nextCaseSector({cases:[]}), 'technology');
 const h={cases:[{sector:'technology',generatedAt:'2026-09-20T12:00:00Z',entityKeys:['microsoft']}]};
 assert.equal(nextCaseSector(h),'traditional');
 const ids=weeklyCaseFallbackSourceIds(registry,h,now);assert.ok(ids.includes('unilever-news'));assert.ok(ids.includes('coca-cola-investor'));assert.ok(!ids.includes('github-changelog'));
 assert.equal(nextCaseSector({cases:[{sector:'traditional',generatedAt:now.toISOString()}]}),'technology');
 assert.deepEqual(getImpairedCoverageGroups({coverageGroups:[{id:'macro',status:'impaired',requiredForDaily:false}]}),[]);
});

test('daily validate-only traverses v2 details without models or SMTP even when send=true',async()=>{
 const root=temp();fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/sources.v1.json'),JSON.stringify({sources:[{id:'official'}]}));
 const result=await runDaily({root,date,now,validateOnly:true,send:true,collectSources:async()=>({sources:[],coverageGroups:[]}),editorialServices:{enrichDiscoveryItems:async()=>({items:[]}),generateEdition:async()=>{throw Error('No model allowed');}}});
 assert.equal(result.status,'validation-complete');assert.equal(result.editorialVersion,2);assert.equal(result.sent,false);
});

test('an empty edition is not cached as ready, allowing the next authorized run to retry',async()=>{
 const root=temp();fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/sources.v1.json'),JSON.stringify({sources:[{id:'official'}]}));
 let count=0;const options={root,date,now,send:false,collectSources:async()=>({sources:[],coverageGroups:[]}),editorialServices:{enrichDiscoveryItems:async()=>({items:[]}),generateEdition:async()=>{count++;return {briefing:{editorialVersion:2,briefingDate:date,candidates:[]},review:{passed:true},costs:[]};},generateThinking:async()=>({thinking:null,costs:[],audit:{status:'no-independent-material'}})}};
 await runDaily(options);await runDaily(options);assert.equal(count,2);assert.ok(!fs.existsSync(path.join(root,'state/edition-ready-'+date+'.json')));
});

test('explicit recovery authorization reaches every editorial model call',async()=>{
 let calls=0;
 await generateEdition({briefingDate:date,candidates:[candidate()]},{allowAuthorizedRecovery:true,callStructured:async options=>{
   calls++;assert.equal(options.allowAuthorizedRecovery,true);
   return caller()(options);
 }});
 assert.ok(calls>=3);
});

test('完整正式链路从模型模拟到渲染，重复未发送运行复用已审稿且不推进历史',async()=>{
 const root=temp();fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/sources.v1.json'),JSON.stringify({sources:[{id:'official'}]}));
 let generations=0;const options={root,date,now,send:false,collectSources:async()=>({sources:[],coverageGroups:[]}),editorialServices:{enrichDiscoveryItems:async()=>({items:[]}),generateEdition:async()=>{generations++;return edition([candidate()]);},generateThinking:async()=>({thinking:null,costs:[],audit:{status:'no-independent-material'}})}};
 const first=await runDaily(options);const second=await runDaily(options);
 assert.equal(first.status,'complete');assert.equal(first.editorialVersion,2);assert.equal(first.sent,false);assert.equal(second.status,'complete');assert.equal(generations,1);
 const selected=JSON.parse(fs.readFileSync(path.join(root,'output/briefing-'+date+'.selected.json'),'utf8'));assert.equal(selected.events.length,1);assert.equal(selected.editorialVersion,2);assert.match(renderHtml(replayResult(selected)),/重点解读/);
 assert.equal(loadEditorialHistory(path.join(root,'state')).events.length,0);
});
