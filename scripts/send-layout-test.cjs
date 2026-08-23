'use strict';

// 仅用于用户人工触发的一次iPhone Gmail排版验证。
// 需要同时传入--send和ENABLE_EMAIL_SEND=true；否则只生成本地.eml文件。

const fs = require('node:fs');
const path = require('node:path');
const { PROJECT_CONFIG } = require('../src/config.cjs');
const { buildMimeMessage, sendWithRetry } = require('../src/mime.cjs');

function parseArguments(argv) {
  const options = { send: false, date: new Date().toISOString().slice(0, 10) };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--send') options.send = true;
    else if (argument === '--date') {
      options.date = argv[index + 1];
      index += 1;
    } else throw new Error(`未知参数：${argument}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error('日期格式必须为YYYY-MM-DD。');
  return options;
}

function plainTextFromHtml(html) {
  return html
    .replaceAll(/<style[\s\S]*?<\/style>/gi, '')
    .replaceAll(/<script[\s\S]*?<\/script>/gi, '')
    .replaceAll(/<br\s*\/?\s*>/gi, '\n')
    .replaceAll(/<\/(?:p|h1|h2|h3|li|tr|section|div)>/gi, '\n')
    .replaceAll(/<[^>]+>/g, '')
    .replaceAll(/&nbsp;/g, ' ')
    .replaceAll(/&amp;/g, '&')
    .replaceAll(/&lt;/g, '<')
    .replaceAll(/&gt;/g, '>')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'design', 'email-visual-mockup-v1.html'), 'utf8');
  const dateLabel = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' })
    .format(new Date(`${options.date}T00:00:00+08:00`));
  const mime = buildMimeMessage({
    date: options.date,
    subject: `[排版测试] 全球晨报｜${dateLabel}`,
    senderName: PROJECT_CONFIG.senderName,
    from: PROJECT_CONFIG.senderAddress,
    to: PROJECT_CONFIG.recipientAddress,
    html,
    text: plainTextFromHtml(html)
  });
  const outputDirectory = path.join(root, 'output');
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, `layout-test-${options.date}.eml`), mime, 'utf8');
  if (options.send) {
    const result = await sendWithRetry(mime, { enabled: true });
    console.log(`LAYOUT_TEST_SENT attempts=${result.attempts} smtp_status=${result.status}`);
  } else {
    console.log('LAYOUT_TEST_READY send=false');
  }
}

main().catch((error) => {
  console.error(`LAYOUT_TEST_FAILED ${error.message}`);
  process.exitCode = 1;
});
