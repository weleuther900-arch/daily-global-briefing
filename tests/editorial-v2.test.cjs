'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const {generateEdition,screeningIssues,selectGenerationPool}=require('../src/editorial-engine.cjs');
const {generateThinking,nextThinkingType}=require('../src/business-thinking.cjs');
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
function draft(c,brief=false){return {title:c.title,conclusion:'公司披露了经营变化。',plainLanguage:'订阅客户继续付费的情况发生变化。',impact:'若客户留存改善，收入可预测性可能提高。',judgmentBoundary:'不能据此推断下一期利润。',sections:brief?[]:[{title:'经营机制',paragraphs:['需要同时观察续费与服务成本。']}],availability:'不适用',evidenceBasis:'公司自报',backgroundReason:'帮助理解数字商业的经营机制',sources:c.sources.map(({organization,title,url})=>({organization,title,url})),criticalFacts:[{claim:'公司披露经营变化',sourceUrls:[c.sources[0].url]}]};}
function caller(overrides={}){return async opts=>{
 const input=JSON.parse(opts.userPrompt);
 if(overrides[opts.schemaName])return {parsed:await overrides[opts.schemaName](input,opts)};
 if(opts.schemaName==='editorial_selection_v2')return {parsed:{decisions:input.map(decision)}};
 if(opts.schemaName==='editorial_event_v2')return {parsed:draft(input.candidate,opts.systemPrompt.includes('短消息：'))};
 return {parsed:{passed:true,issues:[]}};
};}
const edition=async(candidates,options={})=>generateEdition({briefingDate:date,candidates},{callStructured:caller(),...options});

test('v2 retains more than four qualified stories in one category and renders three features plus briefs',async()=>{
 const generated=await edition(names.map((_,i)=>candidate(i)));
 const result=runEditorialPipeline(generated.briefing);
 assert.equal(result.events.length,6);assert.equal(result.events.filter(e=>e.format==='feature').length,3);
 assert.equal(result.events.filter(e=>e.format==='brief'&&e.sections.length===0).length,3);
 assert.match(renderHtml(result),/简讯/);assert.match(renderPlainText(result),/简讯/);
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

test('old background retains original date, rejects missing/future dates and known published content',async()=>{
 const detail={sourceId:'official',sourceName:'官方',sourceTier:'S',sourceKind:'official',url:'https://example.com/old',title:'Software business case',publishedAt:'2020-01-01T00:00:00Z',text:proof,access:'open',detailStatus:'ready'};
 const prepared=prepareEditorialCandidates({items:[detail,{...detail,url:detail.url+'/future',publishedAt:'2027-01-01'},{...detail,url:detail.url+'/unknown',publishedAt:null}]},date,{events:[]});
 assert.equal(prepared.candidateCount,1);assert.equal(prepared.rejectedCount,2);assert.equal(prepared.candidates[0].contentKind,'background');
 const result=runEditorialPipeline((await edition(prepared.candidates)).briefing);
 assert.equal(result.events.length,1);assert.match(renderHtml(result),/2020/);assert.match(renderPlainText(result),/背景补充/);
 const state=temp();recordDeliveredEdition(state,result);
 assert.equal(prepareEditorialCandidates({items:[detail]},date,loadEditorialHistory(state)).candidateCount,0);
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
 if(opts.schemaName==='business_thinking_review_v2')return {parsed:{passed:true,issues:[]}};
 const input=JSON.parse(opts.userPrompt);chosen=input.materials[0];return {parsed:{type:'explanation',topicKey:'转换成本',title:'续费为何不等于满意',paragraphs:['材料显示订阅留存发生变化。','转换成本也可能影响续费；这是条件分析。'],question:'哪些证据能区分满意与迁移困难？',variables:[],limits:'不能仅凭续费推断原因。',sources:chosen.sources,criticalFacts:[{claim:'经营变化',sourceUrls:[chosen.sources[0].url]}]}};
 }});
 assert.equal(chosen.title,independent.title);assert.equal(result.thinking.reviewed,true);
 assert.equal(nextThinkingType(loadEditorialHistory(state)),'explanation');
 recordDeliveredEdition(state,{briefingDate:date,events:[],thinking:result.thinking});
 assert.equal(nextThinkingType(loadEditorialHistory(state)),'exercise');
 assert.match(renderPlainText(runEditorialPipeline({editorialVersion:2,briefingDate:date,candidates:[],thinking:result.thinking})),/续费为何不等于满意/);
});

test('thinking is not withheld when review text explicitly says the draft is accurate',async()=>{
 const source=candidate(0);let reviewCalls=0;
 const result=await generateThinking([source],{thinking:[]},{callStructured:async opts=>{
  if(opts.schemaName==='business_thinking_review_v2'){
   reviewCalls++;
   return {parsed:{passed:false,issues:[{severity:'blocking',problem:'The draft matches the source and is accurate. No issue here.'}]}};
  }
  return {parsed:{type:'explanation',topicKey:'续费机制',title:'续费为何不等于满意',paragraphs:['材料显示订阅留存发生变化。','转换成本也可能影响续费；这是条件分析。'],question:'哪些证据能区分满意与迁移困难？',variables:[],limits:'不能仅凭续费推断原因。',sources:source.sources,criticalFacts:[{claim:'经营变化',sourceUrls:[source.sources[0].url]}]}};
 }});
 assert.equal(reviewCalls,1);assert.equal(result.audit.status,'passed');assert.equal(result.thinking.reviewed,true);
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
