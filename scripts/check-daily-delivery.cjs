'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { beijingDate } = require('../src/runtime.cjs');
const { dailyDeliveryReceipt } = require('../src/weekly-delivery.cjs');
const file = path.join(__dirname,'../state/runs.json');
const date = process.argv[2] || beijingDate(new Date());
const result = dailyDeliveryReceipt(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {runs:[]}, date);
console.log(`DAILY_DELIVERY date=${result.date} smtpAccepted=${result.accepted} runId=${result.runId || 'none'}`);
if (!result.accepted) {
  console.error('正式晨报任务结束后仍没有当日SMTP接受回执，请查看运行状态、预算与内容审计。');
  process.exitCode = 1;
}
