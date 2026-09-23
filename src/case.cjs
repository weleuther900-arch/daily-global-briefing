'use strict';

function caseSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['title', 'subtitle', 'sections', 'decisionQuestions', 'sources'],
    properties: {
      title: { type: 'string' }, subtitle: { type: 'string' },
      sections: { type: 'array', minItems: 5, items: { type: 'object', additionalProperties: false, required: ['title', 'paragraphs'], properties: { title: { type: 'string' }, paragraphs: { type: 'array', minItems: 2, items: { type: 'string' } } } } },
      decisionQuestions: { type: 'array', minItems: 3, items: { type: 'object', additionalProperties: false, required: ['question', 'variables'], properties: { question: { type: 'string' }, variables: { type: 'array', minItems: 2, items: { type: 'string' } } } } },
      sources: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['organization', 'title', 'url'], properties: { organization: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' } } } }
    }
  };
}

function caseReviewSchema() {
  return {
    type: 'object', additionalProperties: false, required: ['passed', 'issues'],
    properties: {
      passed: { type: 'boolean' },
      issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'problem'], properties: { severity: { type: 'string', enum: ['blocking', 'warning'] }, problem: { type: 'string' } } } }
    }
  };
}

function assertCaseReviewPassed(review, materials = []) {
  const issues = Array.isArray(review && review.issues) ? review.issues : [];
  const blockingIssues = issues.filter((issue) => issue && issue.severity === 'blocking');
  if (review && review.passed === true && blockingIssues.length === 0) return review;

  const error = new Error('周日商业案例未通过独立审校。');
  error.code = 'CASE_REVIEW_BLOCKED';
  error.context = {
    review: {
      passed: review && review.passed === true,
      issues: issues.slice(0, 8).map((issue) => ({
        severity: issue && issue.severity,
        problem: String(issue && issue.problem || '').slice(0, 500)
      }))
    },
    materialCount: materials.length,
    materialEntities: [...new Set(materials.map((item) => item.entityKey).filter(Boolean))],
    materialSourceUrls: [...new Set(materials.flatMap((item) => (item.sources || []).map((source) => source.url)).filter(Boolean))]
  };
  throw error;
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

async function generateBusinessCase(materials, options = {}) {
  return require('./case-review.cjs').generateReviewedCase(materials, options, { caseSchema, caseReviewSchema, assertCaseReviewPassed });
}

function renderBusinessCase(caseData, date) {
  const sections = caseData.sections.map((section, index) => `<section><h2>${index + 1}. ${escapeHtml(section.title)}</h2>${section.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}</section>`).join('');
  const questions = caseData.decisionQuestions.map((item, index) => `<div class="question"><h3>${index + 1}. ${escapeHtml(item.question)}</h3><p>${escapeHtml(item.variables.join('；'))}</p></div>`).join('');
  const sources = caseData.sources.map((source) => `<a href="${escapeHtml(source.url)}">${escapeHtml(source.organization)}｜${escapeHtml(source.title)}</a>`).join('<br>');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><style>body{margin:0;background:#eef2f7;color:#1d2733;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.page{max-width:680px;margin:auto;background:#fff;padding:30px 28px;box-sizing:border-box}h1{font-size:27px;line-height:1.35;margin:0}h2{font-size:20px;line-height:1.45;margin:32px 0 10px;border-left:4px solid #2257a8;padding-left:11px}h3{font-size:17px;line-height:1.55;margin:0}p{font-size:17px;line-height:1.78;margin:10px 0;color:#293746}.sub{color:#667383;font-size:14px;line-height:1.6}.question{padding:16px;margin:12px 0;background:#f3f5f7;border-radius:10px}.sources{margin-top:30px;padding-top:20px;border-top:1px solid #d8dde4;font-size:14px;line-height:1.9}a{color:#1959b8}@media(prefers-color-scheme:dark){body,.page{background:#000;color:#f2f2f7}h2{border-color:#8e8e93}p{color:#e5e5ea}.sub{color:#aeaeb2}.question{background:#1c1c1e}.sources{border-color:#38383a}a{color:#d6b26e}}@media(max-width:520px){.page{padding:24px 21px}h1{font-size:25px}}</style></head><body><main class="page"><h1>${escapeHtml(caseData.title)}</h1><p class="sub">${escapeHtml(caseData.subtitle)}｜${escapeHtml(date)}</p>${sections}<section><h2>决策问题</h2>${questions}</section><div class="sources"><strong>原始来源</strong><br>${sources}</div></main></body></html>`;
}

function renderBusinessCaseText(caseData, date) {
  const sections = caseData.sections.map((section, index) => `${index + 1}. ${section.title}\n${section.paragraphs.join('\n\n')}`).join('\n\n');
  const questions = caseData.decisionQuestions.map((item, index) => `${index + 1}. ${item.question}\n观察变量：${item.variables.join('；')}`).join('\n\n');
  const sources = caseData.sources.map((source) => `${source.organization}｜${source.title}\n${source.url}`).join('\n');
  return `${caseData.title}\n${caseData.subtitle}｜${date}\n\n${sections}\n\n决策问题\n${questions}\n\n原始来源\n${sources}\n`;
}

module.exports = { assertCaseReviewPassed, caseReviewSchema, caseSchema, generateBusinessCase, renderBusinessCase, renderBusinessCaseText };
