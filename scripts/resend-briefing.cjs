'use strict';

// 从私有 Actions 归档重建并补发已完成的晨报；不调用任何模型。

const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_CONFIG } = require('../src/config.cjs');
const { buildMimeMessage, sendWithRetry } = require('../src/mime.cjs');
const { renderHtml, renderPlainText } = require('../src/render.cjs');
const { locateSelectedBriefing, replayResult } = require('../src/replay.cjs');
const { recordRun } = require('../src/state.cjs');

function parseArguments(argv) {
  const options = { send: false, input: '', sourceRunId: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--send') options.send = true;
    else if (argument === '--input') options.input = argv[++index] || '';
    else if (argument === '--source-run') options.sourceRunId = argv[++index] || '';
    else throw new Error(`未知参数：${argument}`);
  }
  if (!options.input) throw new Error('必须提供--input补发资料路径。');
  if (!/^\d+$/.test(options.sourceRunId)) throw new Error('必须提供原始 Actions 运行编号 --source-run。');
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(__dirname, '..');
  const { selected } = locateSelectedBriefing(options.input);
  const result = replayResult(selected);
  const html = renderHtml(result);
  const text = renderPlainText(result);
  const runId = `resend-${selected.briefingDate}-${process.env.GITHUB_RUN_ID || 'local'}`;
  const traceId = `resend-${process.env.GITHUB_RUN_ID || selected.briefingDate}`;
  const mime = buildMimeMessage({
    date: selected.briefingDate,
    subject: `[全球晨报·补发] ${selected.briefingDate}`,
    senderName: PROJECT_CONFIG.senderName,
    from: PROJECT_CONFIG.senderAddress,
    to: PROJECT_CONFIG.recipientAddress,
    html,
    text,
    messageId: traceId,
    traceId
  });
  const outputDirectory = path.join(root, 'output');
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, `briefing-${selected.briefingDate}.resend.eml`), mime, 'utf8');
  let sent = false;
  let delivery;
  if (options.send) {
    console.log('MAIL_DELIVERY_ATTEMPT=started');
    const submission = await sendWithRetry(mime, { enabled: true });
    sent = true;
    delivery = { traceId, smtpStatus: submission.status, attempts: submission.attempts, submission: submission.submission, acceptedAt: new Date().toISOString() };
    console.log(`RESEND_ACCEPTED smtp_status=${submission.status} attempts=${submission.attempts}`);
  } else {
    console.log('RESEND_READY=send-disabled');
  }
  const status = { runId, status: 'complete', kind: 'resend', date: selected.briefingDate, sourceRunId: options.sourceRunId, sent, delivery, completedAt: new Date().toISOString() };
  recordRun(path.join(root, 'state/runs.json'), status);
}

main().catch((error) => {
  console.error(`RESEND_FAILED ${error.message}`);
  process.exitCode = 1;
});
