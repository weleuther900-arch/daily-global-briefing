'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runEditorialPipeline } = require('../src/pipeline.cjs');
const { renderHtml, renderPlainText } = require('../src/render.cjs');

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--input' || key === '--output') {
      options[key.slice(2)] = argv[index + 1];
      index += 1;
    } else if (key === '--strict') {
      options.strict = true;
    } else {
      throw new Error(`未知参数：${key}`);
    }
  }
  if (!options.input) throw new Error('必须提供--input。');
  if (!options.output) throw new Error('必须提供--output。');
  return options;
}

function assertWithinProject(targetPath, projectRoot, label) {
  const resolved = path.resolve(targetPath);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label}必须位于项目目录内。`);
  }
  return resolved;
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const options = parseArguments(process.argv.slice(2));
  const inputPath = assertWithinProject(options.input, projectRoot, '输入文件');
  const outputDirectory = assertWithinProject(options.output, projectRoot, '输出目录');

  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const result = runEditorialPipeline(input);
  const html = renderHtml(result);
  const plainText = renderPlainText(result);

  fs.mkdirSync(outputDirectory, { recursive: true });
  const baseName = `briefing-${result.briefingDate}`;
  const htmlPath = path.join(outputDirectory, `${baseName}.html`);
  const textPath = path.join(outputDirectory, `${baseName}.txt`);
  const auditPath = path.join(outputDirectory, `${baseName}.audit.json`);
  const selectedPath = path.join(outputDirectory, `${baseName}.selected.json`);

  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.writeFileSync(textPath, plainText, 'utf8');
  fs.writeFileSync(auditPath, JSON.stringify(result.audit, null, 2) + '\n', 'utf8');
  fs.writeFileSync(selectedPath, JSON.stringify({
    briefingDate: result.briefingDate,
    coverageStart: result.window.start.toISOString(),
    coverageEnd: result.window.end.toISOString(),
    events: result.events
  }, null, 2) + '\n', 'utf8');

  console.log(`BUILD_OK date=${result.briefingDate} events=${result.audit.eventCount} rejected=${result.audit.rejected.length} duplicates=${result.audit.duplicates.length}`);
  console.log(`HTML=${htmlPath}`);
  console.log(`TEXT=${textPath}`);
  console.log(`AUDIT=${auditPath}`);

  if (options.strict && result.audit.rejected.length > 0) {
    process.exitCode = 2;
  }
}

try {
  main();
} catch (error) {
  console.error(`BUILD_FAILED ${error.message}`);
  process.exitCode = 1;
}
