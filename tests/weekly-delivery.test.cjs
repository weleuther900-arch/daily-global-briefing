'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {weeklyDeliveryReceipt} = require('../src/weekly-delivery.cjs');
test('最后备用任务即使周一窗口外才启动，也检查同一周日的真实回执',()=>{
  const state={runs:[{runId:'case-sunday',date:'2026-09-20',kind:'business-case',sent:true,delivery:{smtpStatus:250}}]};
  assert.equal(weeklyDeliveryReceipt(state,new Date('2026-09-21T03:00:00Z')).accepted,true);
  assert.equal(weeklyDeliveryReceipt(state,new Date('2026-09-22T03:00:00Z')).date,'2026-09-20');
});
test('日报成功、旧周成功和仅素材验证不能冒充当周案例已投递',()=>{
  const state={runs:[{date:'2026-09-13',kind:'business-case',sent:true,delivery:{smtpStatus:250}},
    {date:'2026-09-20',kind:'daily',sent:true,delivery:{smtpStatus:250}},
    {date:'2026-09-20',kind:'business-case',status:'case-validation-complete',sent:false}]};
  assert.equal(weeklyDeliveryReceipt(state,new Date('2026-09-20T21:30:00Z')).accepted,false);
});
