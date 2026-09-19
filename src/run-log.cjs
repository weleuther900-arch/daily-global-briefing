'use strict';

const fs = require('node:fs');
const path = require('node:path');

function logPath(root) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, 'logs', 'runtime.jsonl');
  const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('运行日志必须位于项目目录内。');
  return target;
}

// JSONL 便于实时追加、人工查看和后续程序检索；不会把密钥或邮件正文写入日志。
function appendRunLog(root, entry) {
  const target = logPath(root);
  const record = {
    at: new Date().toISOString(),
    ...entry
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8');
  return target;
}

module.exports = { appendRunLog, logPath };
