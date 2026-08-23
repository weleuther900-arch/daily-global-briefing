'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('C:/Users/wangc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--input' || key === '--output') {
      options[key.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`未知参数：${key}`);
    }
  }
  if (!options.input || !options.output) throw new Error('必须提供--input和--output。');
  return options;
}

function assertWithinProject(targetPath, projectRoot, label) {
  const resolved = path.resolve(targetPath);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label}必须位于项目目录内。`);
  return resolved;
}

async function renderPage(browser, inputPath, outputPrefix, colorScheme) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    colorScheme,
    locale: 'zh-CN'
  });
  const page = await context.newPage();
  await page.goto(pathToFileURL(inputPath).href, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${outputPrefix}-${colorScheme}-top.png`, fullPage: false });
  await page.screenshot({ path: `${outputPrefix}-${colorScheme}.png`, fullPage: true });
  await context.close();
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const options = parseArguments(process.argv.slice(2));
  const inputPath = assertWithinProject(options.input, projectRoot, '输入文件');
  const outputPrefix = assertWithinProject(options.output, projectRoot, '输出文件');
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--disable-gpu', '--disable-software-rasterizer']
  });
  try {
    await renderPage(browser, inputPath, outputPrefix, 'light');
    await renderPage(browser, inputPath, outputPrefix, 'dark');
  } finally {
    await browser.close();
  }
  console.log(`PREVIEW_OK prefix=${outputPrefix}`);
}

main().catch((error) => {
  console.error(`PREVIEW_FAILED ${error.message}`);
  process.exitCode = 1;
});
