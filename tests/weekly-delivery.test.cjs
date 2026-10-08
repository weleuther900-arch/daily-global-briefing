'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {dailyDeliveryReceipt,weeklyDeliveryReceipt} = require('../src/weekly-delivery.cjs');
test('投递验收在周日之后仍检查最近一个周日的真实回执',()=>{
  const state={runs:[{runId:'case-sunday',date:'2026-09-20',kind:'business-case',sent:true,delivery:{smtpStatus:250}}]};
  assert.equal(weeklyDeliveryReceipt(state,new Date('2026-09-21T03:00:00Z')).accepted,true);
  assert.equal(weeklyDeliveryReceipt(state,new Date('2026-09-22T03:00:00Z')).date,'2026-09-20');
});
test('日报只有当日SMTP 250回执才算投递，绿色工作流或未发送记录不算',()=>{
  const state={runs:[{date:'2026-09-30',status:'content-stopped',sent:false},
    {date:'2026-09-29',sent:true,delivery:{smtpStatus:250}}]};
  assert.equal(dailyDeliveryReceipt(state,'2026-09-30').accepted,false);
  state.runs.push({runId:'daily',date:'2026-09-30',sent:true,delivery:{smtpStatus:250}});
  assert.equal(dailyDeliveryReceipt(state,'2026-09-30').accepted,true);
});
test('日报成功、旧周成功和仅素材验证不能冒充当周案例已投递',()=>{
  const state={runs:[{date:'2026-09-13',kind:'business-case',sent:true,delivery:{smtpStatus:250}},
    {date:'2026-09-20',kind:'daily',sent:true,delivery:{smtpStatus:250}},
    {date:'2026-09-20',kind:'business-case',status:'case-validation-complete',sent:false}]};
  assert.equal(weeklyDeliveryReceipt(state,new Date('2026-09-20T21:30:00Z')).accepted,false);
});
