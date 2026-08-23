'use strict';

const { PROJECT_CONFIG } = require('./config.cjs');
const { formatBeijingDateTime } = require('./pipeline.cjs');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatBriefingDate(value) {
  const [year, month, day] = value.split('-');
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function renderTags(event) {
  if (!event.tags || event.tags.length === 0) return '';
  const tags = event.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
  return `<div class="tags"><span class="tag-icon">◇</span>${tags}</div>`;
}

function renderConcepts(concepts) {
  return (concepts || []).map((concept) => `
    <div class="concept">
      <div class="concept-label">概念说明</div>
      <div class="concept-name">${escapeHtml(concept.name)}</div>
      <p>${escapeHtml(concept.explanation)}</p>
    </div>`).join('');
}

function renderFormula(formula) {
  if (!formula) return '';
  const notes = (formula.notes || []).map((note) => escapeHtml(note)).join('<br>');
  return `
    <div class="formula">
      <span class="formula-symbol">${escapeHtml(formula.symbol)}</span>
      <span class="formula-text">${escapeHtml(formula.text)}</span>
      ${notes ? `<span class="formula-note">${notes}</span>` : ''}
    </div>`;
}

function renderDataTable(table) {
  if (!table || !Array.isArray(table.rows) || table.rows.length === 0) return '';
  const headings = (table.headings || []).map((heading) => `<th scope="col">${escapeHtml(heading)}</th>`).join('');
  const rows = table.rows.map((row) => {
    const cells = row.map((cell, index) => index === 0
      ? `<th scope="row">${escapeHtml(cell)}</th>`
      : `<td>${escapeHtml(cell)}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table class="data-table" role="presentation"><thead><tr>${headings}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderWatch(watch) {
  return (watch || []).map((item) => `
    <div class="watch-row">
      <div class="watch-title">${escapeHtml(item.item)}</div>
      <div class="watch-reason">${escapeHtml(item.reason)}</div>
    </div>`).join('');
}

function renderSources(sources) {
  const links = sources.map((source) =>
    `<a href="${escapeHtml(source.url)}">${escapeHtml(source.organization)}｜${escapeHtml(source.title)}</a>`
  ).join('<br>');
  return `<div class="source">${links}</div>`;
}

function renderArticle(event, eventNumber) {
  let subNumber = 1;
  const subsections = [];

  for (const section of event.sections || []) {
    const heading = `${eventNumber}.${subNumber} ${escapeHtml(section.title)}`;
    subNumber += 1;
    const paragraphs = (section.paragraphs || []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('');
    subsections.push(`<h3 class="subhead"><span class="subhead-mark"></span>${heading}</h3>${paragraphs}`);
  }

  if (event.concepts && event.concepts.length > 0) {
    const heading = `${eventNumber}.${subNumber} 概念说明`;
    subNumber += 1;
    subsections.push(`<h3 class="subhead"><span class="subhead-mark"></span>${heading}</h3>${renderConcepts(event.concepts)}`);
  }

  if (event.formula) subsections.push(renderFormula(event.formula));
  if (event.dataTable) subsections.push(renderDataTable(event.dataTable));

  if (event.watch && event.watch.length > 0) {
    const heading = `${eventNumber}.${subNumber} 接下来观察`;
    subNumber += 1;
    subsections.push(`<h3 class="subhead"><span class="subhead-mark"></span>${heading}</h3><div class="watch">${renderWatch(event.watch)}</div>`);
  }

  const sourceHeading = `${eventNumber}.${subNumber} 原始来源`;
  subsections.push(`<h3 class="subhead"><span class="subhead-mark"></span>${sourceHeading}</h3>${renderSources(event.sources)}`);

  const evidence = event.evidenceNote ? ` · ${escapeHtml(event.evidenceNote)}` : '';
  return `
    <article class="article">
      <h2 class="article-title">${eventNumber}. ${escapeHtml(event.title)}</h2>
      <div class="meta">公开时间：${escapeHtml(formatBeijingDateTime(new Date(event.publishedAt)))}${evidence}</div>
      ${renderTags(event)}
      <p class="lead">${escapeHtml(event.conclusion)}</p>
      ${subsections.join('')}
    </article>`;
}

function renderThinking(thinking) {
  if (!thinking) return '';
  const context = thinking.context ? `<p>${escapeHtml(thinking.context)}</p>` : '';
  return `
    <aside class="thinking">
      <div class="thinking-label">三分钟商业思考</div>
      <div class="thinking-title">${escapeHtml(thinking.title)}</div>
      ${context}
    </aside>`;
}

function renderHtml(result, config = PROJECT_CONFIG) {
  const sections = config.categories.map((category) => {
    const events = result.events.filter((event) => event.category === category.id);
    if (events.length === 0) return '';
    return `
      <section class="section">
        <h1 class="section-title">${category.number}、${escapeHtml(category.name)}</h1>
        ${events.map((event, index) => renderArticle(event, index + 1)).join('')}
      </section>`;
  }).join('');

  const emptyState = result.events.length === 0
    ? '<p class="empty">过去二十四小时没有达到收录标准的新事件。</p>'
    : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>全球晨报｜${escapeHtml(result.briefingDate)}</title>
  <style>
    :root { color-scheme: light dark; supported-color-schemes: light dark; }
    body { margin:0; padding:0; background:#eef2f7; color:#182230; font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei",Arial,sans-serif; -webkit-text-size-adjust:100%; -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
    a { color:#1959b8; text-decoration:none; }
    .page { width:100%; padding:28px 12px; box-sizing:border-box; }
    .paper { width:100%; max-width:680px; margin:0 auto; background:#fff; border:1px solid #dbe3ee; border-radius:18px; overflow:hidden; box-shadow:0 12px 36px rgba(23,43,77,.08); }
    .masthead { padding:32px 34px 26px; border-top:5px solid #2257a8; border-bottom:1px solid #dbe3ee; }
    .brand { margin:0; color:#102b52; font-size:28px; line-height:1.25; letter-spacing:.02em; font-weight:750; }
    .edition { margin:9px 0 0; color:#526274; font-size:14px; line-height:1.65; }
    .count { display:inline-block; margin-top:14px; padding:6px 10px; color:#174d94; background:#edf4ff; border:1px solid #ccdcf4; border-radius:999px; font-size:13px; font-weight:650; }
    .content { padding:8px 34px 38px; }
    .section { padding-top:32px; }
    .section + .section { margin-top:10px; padding-top:38px; border-top:7px solid #f0f3f7; }
    .section-title { margin:0; padding:0 0 10px 13px; border-left:4px solid #2257a8; color:#102b52; font-size:21px; line-height:1.35; font-weight:750; }
    .article { padding:26px 0 30px; border-bottom:1px solid #e1e7ef; }
    .section .article:last-child { border-bottom:0; }
    .article-title { margin:0; color:#162235; font-size:19px; line-height:1.48; font-weight:720; }
    .meta { margin:8px 0 0; color:#6a7786; font-size:13px; line-height:1.55; }
    .tags { margin:12px 0 1px; font-size:0; }
    .tag-icon { display:inline-block; margin-right:7px; color:#526274; font-size:14px; vertical-align:middle; }
    .tag { display:inline-block; margin:0 6px 6px 0; padding:4px 8px; color:#28517f; background:#f1f6fc; border:1px solid #d8e4f2; border-radius:999px; font-size:12px; line-height:1.2; vertical-align:middle; }
    p { margin:9px 0 0; color:#263444; font-size:16.5px; line-height:1.78; }
    .lead { margin-top:16px; color:#17283c; font-size:17.5px; line-height:1.72; font-weight:650; }
    .subhead { margin:23px 0 8px; color:#234a78; font-size:15px; line-height:1.45; font-weight:750; }
    .subhead-mark { display:inline-block; width:7px; height:7px; margin:0 8px 2px 0; background:#3772bf; border-radius:50%; }
    .concept { margin:15px 0 2px; padding:16px 17px; background:#f3f7fc; border-left:4px solid #5682ba; border-radius:4px 10px 10px 4px; }
    .concept-label { color:#5d6d80; font-size:11px; line-height:1.3; letter-spacing:.08em; }
    .concept-name { margin-top:6px; color:#163f73; font-size:20px; line-height:1.35; font-weight:760; }
    .concept p { margin-top:9px; color:#30445b; font-size:16px; line-height:1.72; }
    .formula { margin:15px 0 2px; padding:15px 16px; color:#21473b; background:#edf7f3; border:1px solid #cbe3d9; border-radius:10px; font-size:14px; line-height:1.7; }
    .formula-symbol { display:block; color:#173f34; font-size:20px; line-height:1.35; font-weight:760; letter-spacing:.02em; }
    .formula-text { display:block; margin-top:6px; color:#275548; font-size:15px; line-height:1.55; font-weight:680; }
    .formula-note { display:block; margin-top:8px; color:#47685e; font-size:13px; line-height:1.65; }
    .data-table { width:100%; margin:15px 0 2px; border-collapse:collapse; border-top:2px solid #758496; border-bottom:2px solid #758496; font-size:14px; }
    .data-table th,.data-table td { padding:10px 8px; text-align:left; }
    .data-table thead th { color:#4d5e71; border-bottom:1px solid #9eabb9; font-weight:700; }
    .data-table tbody th { width:56%; color:#4d5e71; font-weight:560; }
    .data-table tbody td { color:#1e2d3f; font-weight:700; }
    .watch { margin:17px 0 0; padding:0; }
    .watch-row { margin:0 0 15px; padding-left:13px; border-left:2px solid #cbd8e8; }
    .watch-row:last-child { margin-bottom:0; }
    .watch-title { color:#263f5d; font-size:14px; line-height:1.5; font-weight:720; }
    .watch-reason { margin-top:3px; color:#566779; font-size:14px; line-height:1.65; }
    .source { margin:12px 0 0; color:#687789; font-size:13px; line-height:1.85; }
    .source a { color:#1959b8; border-bottom:1px solid #a9c3e6; }
    .thinking { margin:32px 0 4px; padding:22px 20px; color:#f5f8fc; background:#2c2c2e; border-radius:14px; }
    .thinking-label { color:#c7c7cc; font-size:12px; line-height:1.4; letter-spacing:.08em; }
    .thinking-title { margin:5px 0 0; color:#fff; font-size:18px; line-height:1.5; font-weight:730; }
    .thinking p { color:#e8eef6; font-size:15px; line-height:1.75; }
    .empty { margin:32px 0 6px; color:#526274; }
    @media only screen and (max-width:520px) {
      .page { padding:0; }
      .paper { border:0; border-radius:0; box-shadow:none; }
      .masthead { padding:27px 21px 22px; }
      .content { padding:4px 21px 32px; }
      .brand { font-size:25px; }
      .section { padding-top:29px; }
      .section-title { font-size:20px; }
      .article { padding:23px 0 27px; }
      .article-title { font-size:18px; }
      p { font-size:17px; line-height:1.76; }
    }
    @media (prefers-color-scheme:dark) {
      body,.page,.paper { background:#000!important; }
      .paper { border-color:#38383a!important; box-shadow:none!important; }
      .masthead,.article { border-color:#38383a!important; }
      .masthead { border-top-color:#8e8e93!important; }
      .section + .section { border-top-color:#1c1c1e!important; }
      .brand,.section-title,.article-title { color:#f2f2f7!important; }
      .section-title { border-left-color:#8e8e93!important; }
      p,.lead,.data-table tbody td { color:#e5e5ea!important; }
      .edition,.meta,.source { color:#aeaeb2!important; }
      .count,.tag { color:#e5e5ea!important; background:#1c1c1e!important; border-color:#48484a!important; }
      .subhead { color:#d1d1d6!important; }
      .subhead-mark { background:#8e8e93!important; }
      .concept { background:#1c1c1e!important; border-left-color:#636366!important; }
      .concept-name { color:#f2f2f7!important; }
      .concept-label { color:#8e8e93!important; }
      .concept p { color:#e5e5ea!important; }
      .formula { color:#d7eee5!important; background:#14231e!important; border-color:#345549!important; }
      .formula-symbol,.formula-text { color:#d7eee5!important; }
      .formula-note { color:#a9c9bd!important; }
      .data-table { border-color:#8e8e93!important; }
      .data-table thead th,.data-table tbody th { color:#c7c7cc!important; }
      .data-table thead th { border-color:#636366!important; }
      .watch-title { color:#e5e5ea!important; }
      .watch-reason { color:#aeaeb2!important; }
      .source a,a { color:#d6b26e!important; border-color:#8f7447!important; }
    }
  </style>
</head>
<body>
  <div class="page">
    <main class="paper">
      <header class="masthead">
        <div class="brand">全球晨报｜${escapeHtml(formatBriefingDate(result.briefingDate))}</div>
        <div class="edition">覆盖时间：${escapeHtml(result.window.label)}<br>${escapeHtml(config.timezoneLabel)}</div>
        <div class="count">本期 ${result.events.length} 条新闻事件</div>
      </header>
      <div class="content">
        ${emptyState}
        ${sections}
        ${renderThinking(result.thinking)}
      </div>
    </main>
  </div>
</body>
</html>`;
}

function renderPlainText(result, config = PROJECT_CONFIG) {
  const lines = [
    `全球晨报｜${formatBriefingDate(result.briefingDate)}`,
    `覆盖时间：${result.window.label}`,
    config.timezoneLabel,
    `本期 ${result.events.length} 条新闻事件`,
    ''
  ];

  if (result.events.length === 0) lines.push('过去二十四小时没有达到收录标准的新事件。', '');

  for (const category of config.categories) {
    const events = result.events.filter((event) => event.category === category.id);
    if (events.length === 0) continue;
    lines.push(`${category.number}、${category.name}`, '');
    events.forEach((event, eventIndex) => {
      let subNumber = 1;
      lines.push(`${eventIndex + 1}. ${event.title}`);
      lines.push(`公开时间：${formatBeijingDateTime(new Date(event.publishedAt))}`);
      if (event.tags && event.tags.length > 0) lines.push(`标签：${event.tags.join('、')}`);
      lines.push('', event.conclusion, '');
      for (const section of event.sections || []) {
        lines.push(`${eventIndex + 1}.${subNumber} ${section.title}`);
        subNumber += 1;
        lines.push(...section.paragraphs, '');
      }
      if (event.concepts && event.concepts.length > 0) {
        lines.push(`${eventIndex + 1}.${subNumber} 概念说明`);
        subNumber += 1;
        for (const concept of event.concepts) lines.push(concept.name, concept.explanation, '');
      }
      if (event.formula) {
        lines.push(event.formula.symbol, event.formula.text, ...(event.formula.notes || []), '');
      }
      if (event.watch && event.watch.length > 0) {
        lines.push(`${eventIndex + 1}.${subNumber} 接下来观察`);
        subNumber += 1;
        event.watch.forEach((item) => lines.push(`${item.item}：${item.reason}`));
        lines.push('');
      }
      lines.push(`${eventIndex + 1}.${subNumber} 原始来源`);
      event.sources.forEach((source) => lines.push(`${source.organization}｜${source.title}`, source.url));
      lines.push('');
    });
  }

  if (result.thinking) {
    lines.push('三分钟商业思考', result.thinking.title);
    if (result.thinking.context) lines.push(result.thinking.context);
    lines.push('');
  }

  return lines.join('\r\n').trim() + '\r\n';
}

module.exports = { escapeHtml, renderHtml, renderPlainText };
