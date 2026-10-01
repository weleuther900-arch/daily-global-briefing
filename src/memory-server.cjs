'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { normalizeMemory } = require('./memory.cjs');

const MIME_TYPES = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };

function readMemory(statePath) {
  try { return normalizeMemory(JSON.parse(fs.readFileSync(statePath, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return normalizeMemory({ words: [] }); throw error; }
}

function writeMemory(statePath, memory) {
  const directory = path.dirname(statePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(normalizeMemory(memory), null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, statePath);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) { reject(new Error('请求内容过大。')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

function createMemoryServer(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const publicDirectory = path.join(root, 'memory');
  const statePath = path.resolve(options.statePath || path.join(root, 'state', 'memory-words.json'));
  if (!statePath.startsWith(`${root}${path.sep}`)) throw new Error('单词词库必须位于项目目录内。');
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/api/words') {
        if (request.method === 'GET') return send(response, 200, JSON.stringify(readMemory(statePath)));
        if (request.method === 'PUT') {
          const memory = normalizeMemory(JSON.parse(await readBody(request)));
          writeMemory(statePath, memory);
          return send(response, 200, JSON.stringify(memory));
        }
        return send(response, 405, JSON.stringify({ error: '只支持GET和PUT。' }));
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'Method Not Allowed', 'text/plain; charset=utf-8');
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      const filePath = path.resolve(publicDirectory, relative);
      if (!filePath.startsWith(`${publicDirectory}${path.sep}`)) return send(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
      const content = fs.readFileSync(filePath);
      return send(response, 200, request.method === 'HEAD' ? '' : content, MIME_TYPES[path.extname(filePath)] || 'application/octet-stream');
    } catch (error) {
      const status = error.code === 'ENOENT' ? 404 : 400;
      return send(response, status, JSON.stringify({ error: error.message }));
    }
  });
}

module.exports = { createMemoryServer, readMemory, writeMemory };
