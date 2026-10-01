(() => {
  const reviewDays = Array.from({ length: 29 }, (_, index) => index + 1);
  const state = { memory: { version: 1, words: [] }, tab: 'All' };
  const tabs = ['All', 'Learning', 'Mastered'];
  const head = document.querySelector('#table-head');
  const list = document.querySelector('#word-list');
  const status = document.querySelector('#status');

  function tabWords(tab) { return state.memory.words.filter(word => tab === 'All' || (tab === 'Learning' ? !word.mastered : word.mastered)); }
  function counts() { return Object.fromEntries(tabs.map(tab => [tab, tabWords(tab).length])); }
  function message(value, error = false) { status.textContent = value; status.style.color = error ? '#b42318' : ''; }
  async function save() {
    const response = await fetch('/api/words', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(state.memory) });
    if (!response.ok) throw new Error((await response.json()).error || '保存失败。');
    state.memory = await response.json();
  }
  function renderHead() {
    head.innerHTML = `<tr><th>No.</th><th>Word</th><th>Meaning</th><th>Example</th>${reviewDays.map(day => `<th>Day${day}</th>`).join('')}<th>Mastered</th></tr>`;
  }
  function render() {
    renderHead();
    const current = tabWords(state.tab);
    const currentCounts = counts();
    document.querySelectorAll('#tabs button').forEach(button => { const tab = button.dataset.tab; button.classList.toggle('active', tab === state.tab); button.querySelector('span').textContent = currentCounts[tab]; });
    if (!current.length) { list.innerHTML = document.querySelector('#empty-state').innerHTML; return; }
    list.innerHTML = current.map((word, index) => `<tr class="${word.mastered ? 'mastered' : ''}"><td>${index + 1}</td><td class="word">${escapeHtml(word.word)}</td><td class="meaning" title="${escapeHtml(word.meaning)}">${escapeHtml(word.meaning)}</td><td class="example" title="${escapeHtml(word.example)}">${escapeHtml(word.example)}</td>${reviewDays.map(day => checkbox(word.id, `day${day}`, word.reviewDays?.[`day${day}`])).join('')} ${checkbox(word.id, 'mastered', word.mastered)}</tr>`).join('');
  }
  function checkbox(id, field, checked) { return `<td class="check"><input type="checkbox" data-id="${escapeHtml(id)}" data-field="${field}" ${checked ? 'checked' : ''} aria-label="${field}"></td>`; }
  function escapeHtml(value) { return String(value || '').replace(/[&<>'"]/g, character => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[character]); }
  async function load() {
    const response = await fetch('/api/words');
    if (!response.ok) throw new Error('无法读取词库。请通过项目内的 memory 命令启动页面。');
    state.memory = await response.json(); render(); message(`已加载 ${state.memory.words.length} 个单词。`);
  }
  document.querySelector('#tabs').addEventListener('click', event => { const tab = event.target.closest('button')?.dataset.tab; if (tabs.includes(tab)) { state.tab = tab; render(); } });
  list.addEventListener('change', async event => {
    const input = event.target; if (!input.matches('input[type="checkbox"]')) return;
    const word = state.memory.words.find(item => item.id === input.dataset.id); if (!word) return;
    if (input.dataset.field === 'mastered') word.mastered = input.checked;
    else { word.reviewDays ||= {}; word.reviewDays[input.dataset.field] = input.checked; }
    try { await save(); render(); message('已保存。'); } catch (error) { message(error.message, true); await load(); }
  });
  document.querySelector('#add-form').addEventListener('submit', async event => {
    event.preventDefault(); const form = new FormData(event.currentTarget); const word = String(form.get('word') || '').trim(); if (!word) return;
    const idBase = word.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'word'; let id = idBase; let suffix = 2;
    while (state.memory.words.some(item => item.id === id)) id = `${idBase}-${suffix++}`;
    state.memory.words.push({ id, word, meaning: String(form.get('meaning') || '').trim(), example: String(form.get('example') || '').trim(), reviewDays: {}, mastered: false, position: state.memory.words.length });
    try { await save(); event.currentTarget.reset(); state.tab = 'All'; render(); message('单词已加入。'); } catch (error) { message(error.message, true); }
  });
  document.querySelector('#import-file').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try { state.memory = JSON.parse(await file.text()); await save(); state.tab = 'All'; render(); message('词库已导入；旧 Day30 勾选已转换为 Mastered。'); } catch (error) { message(`导入失败：${error.message}`, true); }
    event.target.value = '';
  });
  document.querySelector('#export-button').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(state.memory, null, 2)], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: 'memory-words.json' }); link.click(); URL.revokeObjectURL(url);
  });
  load().catch(error => message(error.message, true));
})();
