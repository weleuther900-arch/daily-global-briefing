'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./discovery.cjs');

function readJson(targetPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function acquireLock(lockPath, options = {}) {
  const staleMs = Number(options.staleMs) || 3 * 60 * 60 * 1000;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const handle = fs.openSync(lockPath, 'wx');
    const value = { pid: process.pid, acquiredAt: new Date().toISOString(), runId: options.runId || null };
    fs.writeFileSync(handle, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.closeSync(handle);
    return value;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lock = readJson(lockPath, null);
    const acquiredAt = lock && new Date(lock.acquiredAt).getTime();
    if (Number.isFinite(acquiredAt) && Date.now() - acquiredAt > staleMs) {
      fs.unlinkSync(lockPath);
      return acquireLock(lockPath, options);
    }
    throw new Error(`已有任务正在运行（${lock && lock.runId ? lock.runId : '运行编号未知'}）。`);
  }
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function recordRun(statePath, run) {
  const state = readJson(statePath, { runs: [] });
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const runs = [run, ...(state.runs || []).filter((item) => item.runId !== run.runId)]
    .filter((item) => !item.completedAt || new Date(item.completedAt).getTime() >= cutoff)
    .slice(0, 120);
  writeJsonAtomic(statePath, { updatedAt: new Date().toISOString(), runs });
}

function updateSentState(statePath, events, sentAt = new Date().toISOString()) {
  const state = readJson(statePath, { events: [] });
  const additions = events.map((event) => ({
    fingerprint: event.fingerprint,
    title: event.title,
    category: event.category,
    urls: (event.sources || []).map((source) => source.url),
    sentAt
  }));
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const retained = [...additions, ...(state.events || [])]
    .filter((event) => new Date(event.sentAt).getTime() >= cutoff)
    .filter((event, index, all) => all.findIndex((candidate) => candidate.fingerprint === event.fingerprint) === index);
  writeJsonAtomic(statePath, { updatedAt: new Date().toISOString(), events: retained });
}

module.exports = { acquireLock, readJson, recordRun, releaseLock, updateSentState, writeJsonAtomic };
