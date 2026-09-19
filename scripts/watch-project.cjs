'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const logsDirectory = path.join(root, 'logs');
const logPath = path.join(logsDirectory, 'project-changes.jsonl');
fs.mkdirSync(logsDirectory, { recursive: true });

function relativePath(value) {
  return path.relative(root, path.resolve(root, value)).replaceAll('\\', '/');
}

function ignored(value) {
  return value === '.git' || value.startsWith('.git/') || value === 'logs' || value.startsWith('logs/');
}

function append(entry) {
  fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

append({ event: 'watcher-start', root });
const watcher = fs.watch(root, { recursive: true }, (changeType, filename) => {
  if (!filename) return;
  const filePath = relativePath(filename);
  if (!filePath || filePath.startsWith('..') || ignored(filePath)) return;
  append({ event: 'file-change', changeType, path: filePath });
});

function close() {
  watcher.close();
  append({ event: 'watcher-stop' });
  process.exit(0);
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
setInterval(() => {}, 60 * 60 * 1000);
