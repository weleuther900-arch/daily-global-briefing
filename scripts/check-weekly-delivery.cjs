'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { weeklyDeliveryReceipt } = require('../src/weekly-delivery.cjs');
const file = path.join(__dirname,'../state/runs.json');
const result = weeklyDeliveryReceipt(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : {runs:[]});
console.log(`WEEKLY_DELIVERY date=${result.date} smtpAccepted=${result.accepted} runId=${result.runId || 'none'}`);
if (!result.accepted) {
  console.error('最后备用任务结束后仍没有本周案例的SMTP接受回执，请查看本次与此前案例审计。');
  process.exitCode = 1;
}
