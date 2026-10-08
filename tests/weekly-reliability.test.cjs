'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateBusinessCase } = require('../src/case.cjs');
const { normalizeReview } = require('../src/case-review.cjs');
const { runDaily, selectWeeklyCaseMaterialGroups } = require('../src/runtime.cjs');
const { weeklyCaseDate, isWeeklyCaseInvocationAllowed } = require('../src/model-window.cjs');

const now = new Date('2026-09-20T00:05:00Z');
const sources = ['microsoft-official-blog', 'nvidia-newsroom'];
const details = { items: sources.flatMap((sourceId, entity) => Array.from({length:3}, (_,i) => ({
  sourceId, sourceName: sourceId, title: '公开经营材料'+i, url:`https://example.com/${entity}/${i}`,
  publishedAt:'2026-09-18T00:00:00Z', detailStatus:'ready', access:'open', text:'经营材料与已确认数据。'.repeat(30)
}))) };
const contentFor = materials => ({ title:'经营案例', subtitle:'哪一个经营条件决定是否扩大投入？',
  sections:['situation','decision','mechanism','outcome'].map(role=>({role,paragraphs:['已核实事实。','只解释本步骤需要的条件性商业分析。']})),
  decisionQuestions:[{question:'哪个条件会改变选择？',variables:['需求','现金流']}],
  sources:materials.flatMap(m=>m.sources)
});
const cost = {model:'fixture',inputTokens:1,outputTokens:1,cny:0};
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dgb-weekly-'));
  fs.mkdirSync(path.join(root,'config'),{recursive:true});
  fs.writeFileSync(path.join(root,'config/sources.v1.json'),JSON.stringify({sources:sources.map(id=>({id}))}));
  return { root, services:{collectSources:async()=>({sources:[]}),enrichDiscoveryItems:async()=>details,
    generateBusinessCase:async materials=>({content:contentFor(materials),review:{passed:true,issues:[]},costs:[cost]})} };
}

test('周日早间案例保持当日期次，超出补跑窗口后停止',()=>{
  assert.equal(weeklyCaseDate(new Date('2026-09-20T00:05:00Z')),'2026-09-20');
  assert.equal(isWeeklyCaseInvocationAllowed(new Date('2026-09-20T00:05:00Z')),true);
  assert.equal(isWeeklyCaseInvocationAllowed(new Date('2026-09-20T03:01:00Z')),false);
  assert.equal(isWeeklyCaseInvocationAllowed(new Date('2026-09-20T12:00:00Z')),false);
  assert.equal(isWeeklyCaseInvocationAllowed(new Date('2026-09-22T12:00:00Z')),false);
});

test('同一主体多份材料组成选题，未来材料与近期主体被排除',()=>{
  const groups=selectWeeklyCaseMaterialGroups(details,{cases:[]},now);
  assert.equal(groups.length,2);
  assert.ok(groups.every(g=>g.length===3&&new Set(g.map(m=>m.entityKey)).size===1));
  const history={cases:[{generatedAt:'2026-09-13T12:00:00Z',entityKeys:['nvidia'],sourceUrls:[]}]};
  assert.deepEqual(selectWeeklyCaseMaterialGroups(details,history,now).map(g=>g[0].entityKey),['microsoft']);
  assert.equal(selectWeeklyCaseMaterialGroups({items:details.items.map(i=>({...i,publishedAt:'2027-01-01T00:00:00Z'}))},{cases:[]},now).length,0);
});

test('商业案例审校失败后只修复一次，修复稿必须再通过独立复核',async()=>{
  const materials=selectWeeklyCaseMaterialGroups(details,{cases:[]},now)[0];
  let calls=0;
  const result=await generateBusinessCase(materials,{now,allowWeeklyCase:true,callStructured:async options=>{
    calls++;
    if(options.schemaName==='weekly_business_case')return {parsed:contentFor(materials),cost};
    return {parsed:calls===2?{passed:false,issues:[{severity:'blocking',problem:'删除未经支持的结果。'}]}:{passed:true,issues:[]},cost};
  }});
  assert.equal(calls,4); assert.equal(result.attempts.length,2); assert.equal(result.review.passed,true);
});

test('修复后仍被拒绝则保留两轮审校，不放行案例',async()=>{
  const materials=selectWeeklyCaseMaterialGroups(details,{cases:[]},now)[0];
  let calls=0;
  await assert.rejects(generateBusinessCase(materials,{callStructured:async options=>{
    calls++;
    return {parsed:options.schemaName==='weekly_business_case'?contentFor(materials):{passed:false,issues:[{severity:'blocking',problem:'数字无依据'}]},cost};
  }}),error=>error.code==='CASE_REVIEW_BLOCKED'&&error.context.attempts.length===2);
  assert.equal(calls,4);
});

test('审校已确认事实正确时，不把缺少次要细节继续作为阻断',()=>{
  const review=normalizeReview({passed:false,issues:[
    {severity:'blocking',problem:'稿件数字正确，但未提及另一项拆解，应补充。'},
    {severity:'blocking',problem:'材料与稿件数字一致，无错误。'},
    {severity:'blocking',problem:'稿件把地点写成新泽西，材料明确为康涅狄格州，应修正。'}
  ]});
  assert.equal(review.passed,false);
  assert.equal(review.issues[0].severity,'warning');
  assert.equal(review.issues[1].severity,'warning');
  assert.equal(review.issues[2].severity,'blocking');
});

test('意见先确认局部正确但最后指出真实错误时仍阻断',()=>{
  const review=normalizeReview({passed:false,issues:[
    {severity:'blocking',problem:'年龄数字正确，但稿件把2018年先任COO写成2018年起任CEO，与材料不符，应修正。'}
  ]});
  assert.equal(review.passed,false);
  assert.equal(review.issues[0].severity,'blocking');
});

test('轻微措辞歧义降为提醒，明确与材料冲突仍阻断',()=>{
  const review=normalizeReview({passed:false,issues:[
    {severity:'blocking',problem:'这里可能引起歧义，建议修正。'},
    {severity:'blocking',problem:'数字错误且与材料不符，建议修正。'}
  ]});
  assert.equal(review.issues[0].severity,'warning');
  assert.equal(review.issues[1].severity,'blocking');
});

test('英文审校确认准确或只要求次要补充时降为提醒',()=>{
  const review=normalizeReview({passed:false,issues:[
    {severity:'blocking',problem:'The draft matches the source and is accurate. No issue here.'},
    {severity:'blocking',problem:'The number is accurate, but the draft omits a parenthetical clarification, which could mislead readers.'},
    {severity:'blocking',problem:'The draft is incorrect and contradicts the source.'}
  ]});
  assert.equal(review.passed,false);
  assert.equal(review.issues[0].severity,'warning');
  assert.equal(review.issues[1].severity,'warning');
  assert.equal(review.issues[2].severity,'blocking');
});

test('案例素材验证在工作日不调用模型或SMTP',async()=>{
  const {root,services}=fixture();
  services.generateBusinessCase=async()=>{throw Error('禁止模型调用');};
  services.sendWithRetry=async()=>{throw Error('禁止SMTP');};
  const result=await runDaily({root,mode:'case',now:new Date('2026-09-23T03:00:00Z'),validateOnly:true,send:true,caseServices:services});
  assert.equal(result.status,'case-validation-complete'); assert.equal(result.sent,false);
});

test('首个选题被拒绝时换第二个选题，成功后跨日重试不会重复投递',async()=>{
  const {root,services}=fixture(); let generations=0,sends=0;
  services.generateBusinessCase=async materials=>{
    generations++;
    if(generations===1){const e=Error('拒绝');e.code='CASE_REVIEW_BLOCKED';throw e;}
    return {content:contentFor(materials),review:{passed:true,issues:[]},costs:[cost]};
  };
  services.sendWithRetry=async()=>{sends++;return {status:250,attempts:1};};
  const first=await runDaily({root,mode:'case',now,send:true,caseServices:services});
  assert.equal(first.sent,true); assert.equal(generations,2);
  const again=await runDaily({root,mode:'case',runId:'other-trigger',now:new Date('2026-09-20T00:20:00Z'),send:true,caseServices:services});
  assert.equal(again.idempotentSkip,true); assert.equal(sends,1); assert.equal(generations,2);
});

test('SMTP失败后保留已审稿件，备用运行直接复用而不重新调用模型',async()=>{
  const {root,services}=fixture();let generations=0,sends=0;
  const generate=services.generateBusinessCase;
  services.generateBusinessCase=async m=>{generations++;return generate(m);};
  services.sendWithRetry=async()=>{sends++;if(sends===1)throw Error('SMTP temporary failure');return {status:250,attempts:1};};
  await assert.rejects(runDaily({root,mode:'case',now,send:true,caseServices:services}),/SMTP temporary/);
  const result=await runDaily({root,mode:'case',now:new Date('2026-09-20T00:50:00Z'),send:true,caseServices:services});
  assert.equal(result.sent,true); assert.equal(result.reusedReviewedDraft,true); assert.equal(generations,1);
});


test('备用任务跳过本周已失败的相同材料，避免重复花费模型调用',async()=>{
  const {root,services}=fixture();let generations=0;
  services.generateBusinessCase=async()=>{generations++;const e=Error('事实未通过');e.code='CASE_REVIEW_BLOCKED';throw e;};
  const first=await runDaily({root,mode:'case',now,send:false,caseServices:services});
  assert.equal(first.status,'case-review-stopped');assert.equal(generations,2);
  const second=await runDaily({root,mode:'case',now:new Date('2026-09-20T00:50:00Z'),send:false,caseServices:services});
  assert.equal(second.status,'case-review-stopped');assert.equal(generations,2);
  assert.ok(!fs.existsSync(path.join(root,'state/business-case-history.json')));
});

test('人工补发明确周日日期时可在常规窗口外运行，且仍走审校链路',async()=>{
  const {root,services}=fixture();
  const result=await runDaily({root,mode:'case',date:'2026-09-27',now:new Date('2026-09-30T03:00:00Z'),allowCaseRecovery:true,send:false,caseServices:services});
  assert.equal(result.status,'complete');assert.equal(result.date,'2026-09-27');assert.equal(result.sent,false);
});
