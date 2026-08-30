'use strict';

const { readJson, writeJsonAtomic } = require('./state.cjs');

const MODEL_PRICES_USD_PER_MILLION = Object.freeze({
  // 价格只用于调用前的保守预算门禁；实际以接口返回用量记账。
  // DeepSeek 采用未命中缓存价格，避免低估预算。
  'deepseek-v4-flash': Object.freeze({ input: 0.14, output: 0.28 }),
  'deepseek-v4-pro': Object.freeze({ input: 0.435, output: 0.87 }),
  'gpt-5-mini': Object.freeze({ input: 0.25, output: 2.00 }),
  'gpt-5.6-luna': Object.freeze({ input: 0.20, output: 1.20 }),
  'gpt-5.6-terra': Object.freeze({ input: 2.00, output: 12.00 })
});

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // DeepSeek 官方估算中中文字符约为 0.6 Token；取 0.8 作为调用前门禁的保守值，
  // 为 JSON、标点和中英文混合输入预留余量。
  return Math.max(1, Math.ceil(text.length * 0.8));
}

function calculateCost(model, inputTokens, outputTokens, usdCnyRate = 7.2) {
  const price = MODEL_PRICES_USD_PER_MILLION[model];
  if (!price) throw new Error(`没有登记模型${model}的费用。`);
  const usd = inputTokens / 1_000_000 * price.input + outputTokens / 1_000_000 * price.output;
  return { model, inputTokens, outputTokens, usd, cny: usd * usdCnyRate, usdCnyRate };
}

function beijingTimestamp(date = new Date()) {
  return new Date(new Date(date).getTime() + 8 * 60 * 60 * 1000);
}

function monthKey(date = new Date()) {
  return beijingTimestamp(date).toISOString().slice(0, 7);
}

function dayKey(date = new Date()) {
  return beijingTimestamp(date).toISOString().slice(0, 10);
}

function getMonthSpend(ledger, month = monthKey()) {
  return (ledger.entries || []).filter((entry) => entry.month === month)
    .reduce((total, entry) => total + Number((entry.budgetCny ?? entry.cny) || 0), 0);
}

function getDayTokenSpend(ledger, day = dayKey()) {
  return (ledger.entries || [])
    .filter((entry) => dayKey(new Date(entry.recordedAt || 0)) === day)
    .reduce((total, entry) => total + Number(entry.inputTokens || 0) + Number(entry.outputTokens || 0), 0);
}

function assertBudget(ledgerPath, projectedCost, monthlyBudgetCny = 10) {
  const ledger = readJson(ledgerPath, { entries: [] });
  const spent = getMonthSpend(ledger);
  if (spent + projectedCost.cny > monthlyBudgetCny) {
    const error = new Error(`费用门禁拒绝调用：本月已用约${spent.toFixed(2)}元，本次上限约${projectedCost.cny.toFixed(2)}元，预算${monthlyBudgetCny.toFixed(2)}元。`);
    error.code = 'MONTHLY_BUDGET_EXCEEDED';
    throw error;
  }
  return { spentCny: spent, remainingAfterProjectedCny: monthlyBudgetCny - spent - projectedCost.cny };
}

function assertDailyTokenBudget(ledgerPath, projectedCost, dailyTokenBudget = 150000) {
  const ledger = readJson(ledgerPath, { entries: [] });
  const spent = getDayTokenSpend(ledger);
  const projected = Number(projectedCost.inputTokens || 0) + Number(projectedCost.outputTokens || 0);
  if (spent + projected > dailyTokenBudget) {
    const error = new Error(`Token门禁拒绝调用：当日已用${spent} Token，本次上限${projected} Token，预算${dailyTokenBudget} Token。`);
    error.code = 'DAILY_TOKEN_BUDGET_EXCEEDED';
    throw error;
  }
  return { spentTokens: spent, remainingAfterProjectedTokens: dailyTokenBudget - spent - projected };
}

function appendCost(ledgerPath, entry) {
  const ledger = readJson(ledgerPath, { entries: [] });
  const value = { ...entry, month: entry.month || monthKey(new Date(entry.recordedAt || Date.now())) };
  writeJsonAtomic(ledgerPath, { updatedAt: new Date().toISOString(), entries: [...(ledger.entries || []), value] });
}

module.exports = { MODEL_PRICES_USD_PER_MILLION, appendCost, assertBudget, assertDailyTokenBudget, beijingTimestamp, calculateCost, dayKey, estimateTokens, getDayTokenSpend, getMonthSpend, monthKey };
