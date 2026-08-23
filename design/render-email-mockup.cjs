const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('C:/Users/wangc/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

async function render(colorScheme, outputName) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    args: ['--disable-gpu', '--disable-software-rasterizer'],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    colorScheme,
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  const input = pathToFileURL(path.join(__dirname, 'email-visual-mockup-v1.html')).href;
  await page.goto(input, { waitUntil: 'networkidle' });
  await page.screenshot({
    path: path.join(__dirname, outputName.replace('.png', '-top.png')),
    fullPage: false,
  });
  await page.screenshot({
    path: path.join(__dirname, outputName),
    fullPage: true,
  });
  await browser.close();
}

(async () => {
  await render('light', 'email-visual-mockup-v1-iphone-light.png');
  await render('dark', 'email-visual-mockup-v1-iphone-dark.png');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
