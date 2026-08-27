'use strict';

const crypto = require('node:crypto');
const tls = require('node:tls');

function encodeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(String(value), 'utf8').toString('base64')}?=`;
}

function foldBase64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');
}

function buildMimeMessage(options) {
  const boundary = `briefing_${crypto.createHash('sha256').update(`${options.date}|${options.subject}`).digest('hex').slice(0, 24)}`;
  const traceId = String(options.traceId || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 120);
  const headers = [
    `From: ${encodeHeader(options.senderName)} <${options.from}>`,
    `To: <${options.to}>`,
    `Subject: ${encodeHeader(options.subject)}`,
    `Date: ${(options.sentAt || new Date()).toUTCString()}`,
    `Message-ID: <${options.messageId || crypto.randomUUID()}@daily-global-briefing.local>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    'X-Priority: 1',
    'Importance: High',
    ...(traceId ? [`X-Daily-Global-Briefing-Trace: ${traceId}`] : [])
  ];
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldBase64(options.text)}`,
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${foldBase64(options.html)}`,
    `--${boundary}--`
  ];
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n`;
}

async function sendWithRetry(mime, options = {}) {
  const attempts = Number(options.attempts) || 3;
  // 邮件投递失败应尽快给出可操作诊断，避免一次晨报在 10 分钟间隔中长时间无反馈。
  const delayMs = options.delayMs == null ? 10 * 1000 : Number(options.delayMs);
  const send = options.sendImpl || sendMimeViaGmail;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { ...(await send(mime, options)), attempts: attempt };
    } catch (error) {
      lastError = error;
      // 认证凭据不正确时，重复登录不会改变结果；直接反馈，避免晨报被无意义重试拖延。
      const permanentAuthenticationFailure = /Gmail SMTP在(?:账号认证|应用密码认证)阶段返回异常/.test(String(error && error.message));
      if (attempt < attempts && !permanentAuthenticationFailure) await (options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delayMs);
    }
  }
  throw new Error(`邮件连续${attempts}次发送失败：${lastError.message}`);
}

function assertEmailSendingEnabled(options) {
  if (options.enabled !== true || process.env.ENABLE_EMAIL_SEND !== 'true') {
    throw new Error('邮件发送开关未同时启用，未连接邮箱。');
  }
}

function smtpResponseCode(response) {
  const match = /^(\d{3})[ -]/.exec(response);
  return match ? Number(match[1]) : null;
}

function assertSmtpResponse(response, acceptedCodes, stage) {
  const code = smtpResponseCode(response);
  if (!acceptedCodes.includes(code)) {
    throw new Error(`Gmail SMTP在${stage}阶段返回异常：${String(response).replaceAll(/\s+/g, ' ').slice(0, 280)}`);
  }
}

function dotStuff(mime) {
  return String(mime).replaceAll(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
}

function openSmtpSession(options = {}) {
  const host = options.host || 'smtp.gmail.com';
  const port = Number(options.port || 465);
  const timeoutMs = Number(options.timeoutMs || 30_000);
  const connect = options.tlsConnect || tls.connect;
  return new Promise((resolve, reject) => {
    let initialConnectionSettled = false;
    let ended = false;
    let terminalError = null;
    let buffer = '';
    let responseLines = [];
    const responses = [];
    const waiters = [];
    const socket = connect({ host, port, servername: host, rejectUnauthorized: true });
    const timeout = setTimeout(() => abort(new Error('Gmail SMTP连接超时。')), timeoutMs);

    function finish(callback, value) {
      if (initialConnectionSettled) return;
      initialConnectionSettled = true;
      clearTimeout(timeout);
      callback(value);
    }

    function rejectWaiters(error) {
      while (waiters.length) waiters.shift().reject(error);
    }

    function abort(error) {
      if (ended || terminalError) return;
      terminalError = error;
      rejectWaiters(error);
      if (!initialConnectionSettled) finish(reject, error);
      if (!socket.destroyed) socket.destroy();
    }

    function emitResponse(response) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(response);
      else responses.push(response);
    }

    function readResponse() {
      if (terminalError) return Promise.reject(terminalError);
      if (responses.length) return Promise.resolve(responses.shift());
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        responseLines.push(line);
        if (/^\d{3} /.test(line)) {
          emitResponse(responseLines.join('\n'));
          responseLines = [];
        }
      }
    });
    socket.once('error', abort);
    socket.once('close', () => {
      if (!ended) abort(new Error('Gmail SMTP连接已关闭。'));
    });
    socket.once('secureConnect', () => {
      socket.setTimeout(timeoutMs, () => abort(new Error('Gmail SMTP会话超时。')));
      finish(resolve, {
        readResponse,
        write(value) {
          if (terminalError) throw terminalError;
          socket.write(value);
        },
        close() { ended = true; socket.end(); }
      });
    });
  });
}

async function sendMimeViaGmail(mime, options = {}) {
  assertEmailSendingEnabled(options);
  const username = String(options.username || process.env.BRIEFING_SENDER_ADDRESS || '').trim();
  const recipient = String(options.recipient || process.env.BRIEFING_RECIPIENT_ADDRESS || '').trim();
  const appPassword = String(options.appPassword || process.env.GMAIL_APP_PASSWORD || '').replaceAll(/\s+/g, '');
  if (!appPassword) throw new Error('缺少GMAIL_APP_PASSWORD；不会连接Gmail。');
  if (!username || !recipient) throw new Error('缺少BRIEFING_SENDER_ADDRESS或BRIEFING_RECIPIENT_ADDRESS；不会连接Gmail。');
  const session = await openSmtpSession(options);
  try {
    assertSmtpResponse(await session.readResponse(), [220], '连接');
    session.write('EHLO daily-global-briefing\r\n');
    assertSmtpResponse(await session.readResponse(), [250], 'EHLO');
    session.write('AUTH LOGIN\r\n');
    assertSmtpResponse(await session.readResponse(), [334], '认证开始');
    session.write(`${Buffer.from(username, 'utf8').toString('base64')}\r\n`);
    assertSmtpResponse(await session.readResponse(), [334], '账号认证');
    session.write(`${Buffer.from(appPassword, 'utf8').toString('base64')}\r\n`);
    assertSmtpResponse(await session.readResponse(), [235], '应用密码认证');
    session.write(`MAIL FROM:<${username}>\r\n`);
    assertSmtpResponse(await session.readResponse(), [250], '发件人');
    session.write(`RCPT TO:<${recipient}>\r\n`);
    assertSmtpResponse(await session.readResponse(), [250, 251], '收件人');
    session.write('DATA\r\n');
    assertSmtpResponse(await session.readResponse(), [354], '正文准备');
    session.write(`${dotStuff(mime)}\r\n.\r\n`);
    const submissionResponse = await session.readResponse();
    assertSmtpResponse(submissionResponse, [250], '邮件提交');
    session.write('QUIT\r\n');
    assertSmtpResponse(await session.readResponse(), [221], '退出');
    session.close();
    return {
      status: smtpResponseCode(submissionResponse),
      // 仅保存服务器已受理的简短回执，便于私有运行记录追踪；不含账号或邮件正文。
      submission: String(submissionResponse).replaceAll(/\s+/g, ' ').slice(0, 280)
    };
  } catch (error) {
    session.close();
    throw error;
  }
}

module.exports = { buildMimeMessage, dotStuff, encodeHeader, sendMimeViaGmail, sendWithRetry };
