'use strict';

const path = require('node:path');
const { createMemoryServer } = require('../src/memory-server.cjs');

const portArgument = process.argv.indexOf('--port');
const port = portArgument >= 0 ? Number(process.argv[portArgument + 1]) : 4173;
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是1至65535之间的整数。');
const root = path.resolve(__dirname, '..');
const server = createMemoryServer({ root });
server.listen(port, '127.0.0.1', () => console.log(`MEMORY_READY http://127.0.0.1:${port}`));
