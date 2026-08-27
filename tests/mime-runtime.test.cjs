'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildMimeMessage, dotStuff, sendMimeViaGmail, sendWithRetry } = require('../src/mime.cjs');
const { acquireLock, releaseLock } = require('../src/state.cjs');
const { beijingDate, trimDiscoveryForWindow } = require('../src/runtime.cjs');

test('邮件文件同时包含HTML和纯文本且中文标题编码', () => {
  const mime = buildMimeMessage({ date: '2026-08-17', subject: '[全球晨报] 2026-08-17', senderName: '全球晨报', from: 'briefing@example.invalid', to: 'briefing@example.invalid', text: '正文', html: '<p>正文</p>', sentAt: new Date('2026-08-17T00:00:00Z'), messageId: 'test', traceId: 'test-run-1' });
  assert.match(mime, /multipart\/alternative/);
  assert.match(mime, /text\/plain/);
  assert.match(mime, /text\/html/);
  assert.match(mime, /briefing@example\.invalid/);
  assert.match(mime, /Importance: High/);
  assert.match(mime, /X-Daily-Global-Briefing-Trace: test-run-1/);
  assert.doesNotMatch(mime, /Subject: \[全球晨报\]/);
});

test('正式发信失败后最多重试两次', async () => {
  const previous = process.env.ENABLE_EMAIL_SEND;
  process.env.ENABLE_EMAIL_SEND = 'true';
  let calls = 0;
  const sendImpl = async () => { calls += 1; if (calls < 3) throw new Error('temporary'); return { status: 250 }; };
  const result = await sendWithRetry('mime', { enabled: true, sendImpl, delayMs: 0 });
  if (previous === undefined) delete process.env.ENABLE_EMAIL_SEND;
  else process.env.ENABLE_EMAIL_SEND = previous;
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
});

test('只有代码参数和环境开关同时启用才允许触发发信', async () => {
  await assert.rejects(() => sendMimeViaGmail('x', { enabled: false }), /发送开关未同时启用/);
});

test('缺少Gmail应用密码时不会建立SMTP连接', async () => {
  const previousSwitch = process.env.ENABLE_EMAIL_SEND;
  const previousPassword = process.env.GMAIL_APP_PASSWORD;
  process.env.ENABLE_EMAIL_SEND = 'true';
  delete process.env.GMAIL_APP_PASSWORD;
  await assert.rejects(() => sendMimeViaGmail('x', { enabled: true }), /缺少GMAIL_APP_PASSWORD/);
  if (previousSwitch === undefined) delete process.env.ENABLE_EMAIL_SEND;
  else process.env.ENABLE_EMAIL_SEND = previousSwitch;
  if (previousPassword === undefined) delete process.env.GMAIL_APP_PASSWORD;
  else process.env.GMAIL_APP_PASSWORD = previousPassword;
});

test('缺少投递地址时不会建立SMTP连接', async () => {
  const previousSwitch = process.env.ENABLE_EMAIL_SEND;
  const previousPassword = process.env.GMAIL_APP_PASSWORD;
  const previousSender = process.env.BRIEFING_SENDER_ADDRESS;
  const previousRecipient = process.env.BRIEFING_RECIPIENT_ADDRESS;
  process.env.ENABLE_EMAIL_SEND = 'true';
  process.env.GMAIL_APP_PASSWORD = 'test-password';
  delete process.env.BRIEFING_SENDER_ADDRESS;
  delete process.env.BRIEFING_RECIPIENT_ADDRESS;
  await assert.rejects(() => sendMimeViaGmail('x', { enabled: true }), /缺少BRIEFING_SENDER_ADDRESS或BRIEFING_RECIPIENT_ADDRESS/);
  if (previousSwitch === undefined) delete process.env.ENABLE_EMAIL_SEND;
  else process.env.ENABLE_EMAIL_SEND = previousSwitch;
  if (previousPassword === undefined) delete process.env.GMAIL_APP_PASSWORD;
  else process.env.GMAIL_APP_PASSWORD = previousPassword;
  if (previousSender === undefined) delete process.env.BRIEFING_SENDER_ADDRESS;
  else process.env.BRIEFING_SENDER_ADDRESS = previousSender;
  if (previousRecipient === undefined) delete process.env.BRIEFING_RECIPIENT_ADDRESS;
  else process.env.BRIEFING_RECIPIENT_ADDRESS = previousRecipient;
});

test('SMTP正文会安全转义以点号开头的行', () => {
  assert.equal(dotStuff('.first\n.second\r\nthird'), '..first\r\n..second\r\nthird');
});

test('运行锁拒绝重入并可安全释放', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dgb-lock-'));
  const lock = path.join(directory, 'daily.lock');
  acquireLock(lock, { runId: 'a' });
  assert.throws(() => acquireLock(lock, { runId: 'b' }), /已有任务正在运行/);
  releaseLock(lock);
  assert.equal(fs.existsSync(lock), false);
});

test('北京时间日期与详情预筛选保持窗口边界', () => {
  assert.equal(beijingDate(new Date('2026-08-16T16:01:00Z')), '2026-08-17');
  const discovery = { sources: [{ items: [{ publishedAt: '2026-08-15T23:00:00Z' }, { publishedAt: '2026-08-16T23:00:00Z' }, { publishedAt: null }] }] };
  const trimmed = trimDiscoveryForWindow(discovery, { start: new Date('2026-08-15T23:00:00Z'), end: new Date('2026-08-16T23:00:00Z') }, 1);
  assert.equal(trimmed.sources[0].items.length, 2);
});
