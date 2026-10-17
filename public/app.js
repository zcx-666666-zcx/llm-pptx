import { consumePlanStream, completedSlides, readSse } from './stream.js';
import { layoutSlide, layoutLabels, themes } from './layout.js';
import { moveStep, mergeStep, splitStep, compactPage, compactPlan } from './steps.js';
const $ = id => document.getElementById(id);
const state = { deck: null, index: 0, origin: '', pptx: null, inventory: null, busy: false, aiConfigured: false };
let generationController = null, animationController = null;
const sample = '# 静态生成与动画加工方案\n\n## 两阶段工作流\n- 根据文本或文档生成可编辑的静态 PPTX。\n- 在 PowerPoint 中调整文字、图片与页面布局。\n- 重新上传调整后的文件，为选定对象添加原生入场动画。\n\n## 第一阶段：内容与排版\n- 原文分页按标题和段落组织内容，保留原始文字。\n- AI 编排通过配置的模型服务整理重点与讲稿。\n- 导出后，每个文本框仍可单独编辑。\n\n## 第二阶段：动画加工\n- 读取重新上传的 PPTX，识别各页的文字、图片和组合。\n- 选择淡入或出现，按单击或自动顺序播放。\n- 默认保留已有动画，避免重复加工。';
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); $('notice').hidden = false; }
async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) { let data; try { data = await response.json(); } catch {} throw new Error(data?.error || `请求失败（HTTP ${response.status}）`); }
  return response;
}
const jsonPost = (url, data) => api(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
function buttons() {
  $('plan-button').disabled = state.busy;
  $('sample-button').disabled = state.busy; $('layout-sample-button').disabled = state.busy;
  $('export-button').disabled = state.busy || !state.deck;
  $('animate-button').disabled = state.busy || !state.pptx || !state.inventory;
  for (const el of $('inventory').querySelectorAll('button,input,select')) el.disabled = state.busy || (el.dataset.ai === 'true' && !state.aiConfigured);
  $('document-input').disabled = state.busy; $('pptx-input').disabled = state.busy;
  document.body.classList.toggle('busy', state.busy);
  $('panel-static').setAttribute('aria-busy', String(state.busy));
  $('panel-motion').setAttribute('aria-busy', String(state.busy));
}
async function work(action, label, button) {
  if (state.busy) return;
  state.busy = true; $('notice').hidden = true; buttons();
  const previous = button?.textContent;
  if (button) button.textContent = label;
  try { await action(); } catch (error) { notice(error.message || '操作失败，请重试', true); }
  finally { state.busy = false; if (button) button.textContent = previous; buttons(); }
}
function stage(name) {
  for (const item of ['static', 'motion']) {
    const active = item === name;
    $('panel-' + item).hidden = !active;
    $('tab-' + item).classList.toggle('active', active);
    $('tab-' + item).setAttribute('aria-selected', String(active));
  }
  $('notice').hidden = true;
}
$('tab-static').addEventListener('click', () => stage('static'));
$('tab-motion').addEventListener('click', () => stage('motion'));
$('go-motion').addEventListener('click', () => stage('motion'));
for (const name of ['static', 'motion']) $('tab-' + name).addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const target = event.key === 'Home' ? 'static' : event.key === 'End' ? 'motion' : name === 'static' ? 'motion' : 'static';
  stage(target); $('tab-' + target).focus();
});
$('config-button').addEventListener('click', () => { $('config-panel').hidden = !$('config-panel').hidden; $('config-button').setAttribute('aria-expanded', String(!$('config-panel').hidden)); });
$('source-text').addEventListener('input', () => { $('source-count').textContent = `${$('source-text').value.length.toLocaleString()} 字符`; });
$('sample-button').addEventListener('click', () => { $('source-text').value = sample; $('deck-title').value = '静态生成与动画加工方案'; $('source-text').dispatchEvent(new Event('input')); });
$('generation-mode').addEventListener('change', () => {
  const ai = $('generation-mode').value === 'ai';
  $('mode-description').textContent = ai ? '将材料发送给当前模型，实时接收内容并逐页显示演示草稿。' : '按标题与段落分页，保留原文。长段落会自动拆分。';
});
$('document-input').addEventListener('change', event => work(async () => {
  const file = event.target.files[0]; if (!file) return;
  const form = new FormData(); form.set('file', file);
  const data = await (await api('/api/documents', { method: 'POST', body: form })).json();
  $('source-text').value = data.text; $('source-text').dispatchEvent(new Event('input'));
  notice(`已导入 ${file.name}，共 ${data.text.length.toLocaleString()} 字符。`);
  event.target.value = '';
}));
$('plan-button').addEventListener('click', () => work(async () => {
  const input = { text: $('source-text').value, title: $('deck-title').value, mode: $('generation-mode').value, ...($('slide-count').value ? { slideCount: Number($('slide-count').value) } : {}) };
  let data;
  if (input.mode === 'ai') {
    generationController = new AbortController();
    $('generation-stream').hidden = false; $('stream-slides').replaceChildren();
    $('stream-status').textContent = '正在整理材料，页面内容会逐页出现…';
    $('cancel-generation').disabled = false;
    let text = '', rendered = 0;
    try {
      const response = await api('/api/plan/stream', { method: 'POST', signal: generationController.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      data = await consumePlanStream(response, delta => {
        text += delta;
        const slides = completedSlides(text);
        $('stream-status').textContent = `已接收 ${text.length.toLocaleString()} 字符 · 已生成 ${slides.length} 页，正在继续…`;
        for (; rendered < slides.length; rendered++) {
          const slide = slides[rendered], card = node('article', undefined, 'stream-slide');
          card.append(node('small', `第 ${rendered + 1} 页`), node('h3', slide.title));
          if (slide.subtitle) card.append(node('p', slide.subtitle));
          for (const bullet of slide.bullets || []) card.append(node('p', bullet));
          for (const item of slide.items || []) { card.append(node('strong', [item.value, item.heading].filter(Boolean).join(' '))); if (item.body) card.append(node('p', item.body)); }
          if (slide.takeaway) card.append(node('p', slide.takeaway));
          $('stream-slides').append(card);
        }
      });
      $('stream-status').textContent = `已完成 ${data.deck.slides.length} 页，全部内容已校验。`;
    } catch (error) {
      const cancelled = generationController.signal.aborted;
      $('stream-status').textContent = cancelled ? '已停止生成。' : '生成未完成，请重试。';
      throw new Error(cancelled ? '已停止生成，现有草稿已保留。' : error.message);
    } finally {
      generationController = null; $('cancel-generation').disabled = true;
    }
  } else {
    $('generation-stream').hidden = true;
    data = await (await jsonPost('/api/plan', input)).json();
  }
  state.deck = data.deck; state.index = 0; state.origin = data.origin;
  $('preview-empty').hidden = true; $('deck-workspace').hidden = false; $('handoff').hidden = true;
  $('deck-meta').textContent = `${data.deck.slides.length} 页 · ${data.origin === 'ai' ? 'AI 编排' : '原文分页'}`;
  renderNavigation(); renderEditor(); renderCanvas();
  notice(`已生成 ${data.deck.slides.length} 页草稿，可逐页编辑后下载静态 PPTX。`);
}, '正在编排页面…', $('plan-button')));
$('cancel-generation').addEventListener('click', () => generationController?.abort());
$('layout-sample-button').addEventListener('click', () => work(async () => {
  state.deck = await (await api('/design-example.json')).json(); state.index = 0; state.origin = 'example';
  $('preview-empty').hidden = true; $('deck-workspace').hidden = false; $('handoff').hidden = true;
  $('deck-meta').textContent = `${state.deck.slides.length} 页 · 版式示例`;
  renderNavigation(); renderEditor(); renderCanvas();
  notice('已载入版式示例，可逐页查看、编辑或下载。');
}));

function renderNavigation() {
  $('slide-list').replaceChildren();
  state.deck.slides.forEach((slide, i) => {
    const li = node('li'), button = node('button', undefined, `slide-nav-button${i === state.index ? ' selected' : ''}`);
    button.type = 'button'; button.setAttribute('aria-label', `第 ${i + 1} 页：${slide.title}`); button.setAttribute('aria-current', i === state.index ? 'page' : 'false');
    button.append(node('small', String(i + 1).padStart(2, '0')), node('span', slide.title));
    button.addEventListener('click', () => { state.index = i; renderNavigation(); renderEditor(); renderCanvas(); });
    li.append(button); $('slide-list').append(li);
  });
}
function renderCanvas() {
  if (!state.deck) return;
  const slide = state.deck.slides[state.index], canvas = $('slide-preview'), colors = themes[$('theme-select').value];
  canvas.className = 'slide-preview geometry-preview'; canvas.replaceChildren(); canvas.style.backgroundColor = `#${colors.bg}`;
  try {
    for (const o of layoutSlide(slide, state.index + 1)) {
      const el = node(o.kind === 'text' ? 'p' : 'div', o.text, 'preview-object');
      Object.assign(el.style, { left: `${o.x / 13.333333 * 100}%`, top: `${o.y / 7.5 * 100}%`, width: `${o.w / 13.333333 * 100}%`, height: `${o.h / 7.5 * 100}%` });
      if (o.kind === 'text') Object.assign(el.style, { fontSize: `${o.size / 9.6}cqw`, color: `#${colors[o.color]}`, fontWeight: o.bold ? '700' : '400', textAlign: o.align || 'left', fontFamily: `${colors.font}, PingFang SC, sans-serif` });
      else { el.style.backgroundColor = `#${colors[o.color]}`; if (o.kind === 'ellipse') el.style.borderRadius = '50%'; }
      canvas.append(el);
    }
  } catch (error) { canvas.append(node('p', error.message, 'layout-error')); }
}
function editorField(label, value, max, update, multiline = false) {
  const id = `editor-${$('slide-fields').children.length}`, wrapper = node('div'), caption = node('label', label), input = node(multiline ? 'textarea' : 'input');
  caption.htmlFor = id; input.id = id; input.value = value; input.maxLength = max;
  input.addEventListener('input', () => { update(input.value); renderCanvas(); });
  wrapper.append(caption, input); $('slide-fields').append(wrapper);
}
function renderEditor() {
  const slide = state.deck.slides[state.index]; $('slide-fields').replaceChildren();
  const layoutLabel = node('label', '页面布局'), layoutSelect = node('select'); layoutSelect.setAttribute('aria-label', '页面布局');
  for (const [value, text] of Object.entries(layoutLabels)) { const option = node('option', text); option.value = value; layoutSelect.append(option); }
  layoutSelect.value = slide.layout; layoutSelect.addEventListener('change', () => { slide.layout = layoutSelect.value; renderEditor(); renderCanvas(); }); $('slide-fields').append(layoutLabel, layoutSelect);
  editorField('页标题', slide.title, 64, value => { slide.title = value; renderNavigation(); });
  editorField('栏目（可选）', slide.eyebrow || '', 36, value => { slide.eyebrow = value; });
  editorField('副标题', slide.subtitle || '', 140, value => { slide.subtitle = value; });
  (slide.bullets || []).forEach((text, i) => editorField(`正文 ${i + 1}`, text, 150, value => { slide.bullets[i] = value; }, true));
  (slide.items || []).forEach((item, i) => {
    if (slide.layout === 'metrics' || item.value) editorField(`数值 ${i + 1}`, item.value || '', 16, value => { if (value.trim()) item.value = value; else delete item.value; });
    editorField(`观点 ${i + 1}`, item.heading, 40, value => { item.heading = value; });
    editorField(`说明 ${i + 1}`, item.body || '', 150, value => { item.body = value; }, true);
    const remove = node('button', `删除观点 ${i + 1}`, 'text-button'); remove.type = 'button';
    remove.addEventListener('click', () => { slide.items.splice(i, 1); if (!slide.items.length) delete slide.items; renderEditor(); renderCanvas(); }); $('slide-fields').append(remove);
  });
  const add = node('button', slide.bullets?.length ? '添加正文' : '添加观点', 'text-button'); add.type = 'button';
  add.disabled = (slide.items?.length || slide.bullets?.length || 0) >= (slide.layout === 'metrics' ? 4 : 5);
  add.addEventListener('click', () => {
    if (slide.bullets?.length) slide.bullets.push('请填写正文');
    else { slide.items ||= []; slide.items.push({ heading: '请填写观点', body: '', ...(slide.layout === 'metrics' ? { value: '待填写' } : {}) }); }
    renderEditor(); renderCanvas();
  }); $('slide-fields').append(add);
  editorField('本页结论（可选）', slide.takeaway || '', 100, value => { slide.takeaway = value; });
  editorField('讲稿备注', slide.notes || '', 5000, value => { slide.notes = value; }, true);
  $('slide-fields').append(node('p', '更多排版调整可在导出后使用 PowerPoint 或 WPS 完成。', 'editor-note'));
}
$('theme-select').addEventListener('change', renderCanvas);
async function download(response, fallback) {
  const blob = await response.blob(), url = URL.createObjectURL(blob), anchor = node('a');
  const match = response.headers.get('content-disposition')?.match(/filename\*=UTF-8''([^;]+)/i);
  anchor.download = match ? decodeURIComponent(match[1]) : fallback;
  anchor.href = url; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
$('export-button').addEventListener('click', () => work(async () => {
  const response = await jsonPost('/api/export', { deck: state.deck, theme: $('theme-select').value });
  await download(response, '静态演示.pptx'); $('handoff').hidden = false;
  notice('静态文件已下载。完成手动排版后，在“转换动态 PPTX”中上传保存后的文件。');
}, '正在导出…', $('export-button')));
async function loadPptx(file) {
  // Clear the previous inventory before any new request, so a failed replacement
  // can never apply stale shape IDs to a different uploaded file.
 state.pptx = null; state.inventory = null; $('inventory').replaceChildren(); $('inventory-empty').hidden = false; $('animation-report').hidden = true; $('pptx-filename').textContent = '选择调整后的 PPTX'; buttons();
  if (file.size > 30 * 1024 * 1024) throw new Error('文件大小不能超过 30 MB');
  if (!file.name.toLowerCase().endsWith('.pptx')) throw new Error('请选择 .pptx 文件');
  const form = new FormData(); form.set('file', file);
  const info = await (await api('/api/animation-plan', { method: 'POST', body: form })).json();
  state.pptx = file; state.inventory = info;
  $('pptx-filename').textContent = file.name; $('inventory-empty').hidden = true;
  const count = info.slides.reduce((sum, s) => sum + s.steps.length, 0);
  $('inventory-meta').textContent = `${info.slides.length} 页，${count} 个建议步骤。修改只影响当前页。`;
  renderInventory(); notice('已根据上传文件生成步骤，可调整顺序、点击停顿点与时长后下载。');
}
$('pptx-input').addEventListener('change', event => work(async () => { const file = event.target.files[0]; if (file) await loadPptx(file); event.target.value = ''; }));
for (const type of ['dragover', 'dragleave', 'drop']) $('pptx-drop').addEventListener(type, event => {
  event.preventDefault(); $('pptx-drop').classList.toggle('dragging', type === 'dragover');
  if (type === 'drop' && event.dataTransfer.files[0]) work(() => loadPptx(event.dataTransfer.files[0]));
});
function selectField(label, value, options, update) {
  const wrapper = node('label', label, 'step-field'), select = node('select'); select.setAttribute('aria-label', label);
  for (const [key, text] of options) { const option = node('option', text); option.value = key; select.append(option); }
  select.value = value; select.addEventListener('change', () => update(select.value)); wrapper.append(select); return wrapper;
}
function action(text, callback, label = text) {
  const button = node('button', text, 'text-button step-action'); button.type = 'button'; button.setAttribute('aria-label', label);
  button.addEventListener('click', () => { if (state.busy) return; try { callback(); renderInventory(); buttons(); } catch (error) { notice(error.message, true); } }); return button;
}
function renderInventory() {
  const open = new Set([...$('inventory').querySelectorAll('details[open]')].map(el => el.dataset.page));
  const first = !$('inventory').children.length; $('inventory').replaceChildren();
  for (const page of state.inventory.slides) {
    const section = node('details', undefined, 'inventory-slide'); section.dataset.page = String(page.number); section.open = first ? page.number === 1 : open.has(String(page.number));
    const summary = node('summary', `${page.number}. ${page.title}`); summary.append(node('small', page.hidden ? '隐藏页 · 保留' : page.hasAnimation && !page.replaceExisting ? '已有动画 · 保留' : `${page.steps.length} 步 · ${page.steps.filter(s => s.trigger === 'click').length} 个点击停顿`)); section.append(summary);
    const tools = node('div', undefined, 'page-tools');
    if (!page.hidden) {
      tools.append(selectField('页面节奏', page.policy, [['auto', '自动展开'], ['steps', '分步讲解'], ...(page.hasAnimation ? [['preserve', '保留原动画']] : []), ['skip', '保留静态']], value => { page.policy = value; if (value === 'auto') page.steps.forEach(s => { s.trigger = 'auto'; }); if (value === 'steps') page.steps.forEach((s, i) => { s.trigger = i === 0 ? 'auto' : 'click'; }); renderInventory(); buttons(); }));
      tools.append(selectField('页面切换', page.transition, [['fade', '柔和淡化'], ['none', '直接切换']], value => { page.transition = value; }));
      const transitionLabel = node('label', '切换时长（毫秒）', 'step-field'), transitionDuration = node('input'); transitionDuration.type = 'number'; transitionDuration.min = '200'; transitionDuration.max = '1800'; transitionDuration.step = '50'; transitionDuration.value = page.transitionDuration; transitionDuration.addEventListener('change', () => { page.transitionDuration = Number(transitionDuration.value); }); transitionLabel.append(transitionDuration); tools.append(transitionLabel);
      const ai = node('button', 'AI 优化本页', 'text-button step-action'); ai.type = 'button'; ai.dataset.ai = 'true'; ai.disabled = !state.aiConfigured; ai.addEventListener('click', () => refinePage(page, ai)); tools.append(ai);
      if (page.hasAnimation) {
        const label = node('label', undefined, 'checkbox-label'), check = node('input'); check.type = 'checkbox'; check.checked = page.replaceExisting;
        check.addEventListener('change', () => { page.replaceExisting = check.checked; page.policy = check.checked ? page.steps.some(s => s.trigger === 'click') ? 'steps' : 'auto' : 'preserve'; renderInventory(); buttons(); }); label.append(check, node('span', '重建本页动画')); tools.append(label);
      }
    }
    section.append(tools);
    for (const warning of page.warnings) section.append(node('p', warning, 'page-warning'));
    if (page.policy === 'skip' || page.policy === 'preserve' || page.hidden || (page.hasAnimation && !page.replaceExisting)) section.append(node('p', page.policy === 'skip' ? '保留页面当前状态，不新增动画。' : '保留本页原有动画。重建后才能应用新步骤。', 'help-text'));
    else {
      const list = node('ol', undefined, 'step-list');
      page.steps.forEach((step, index) => {
        const row = node('li', undefined, 'animation-step'), top = node('div', undefined, 'step-heading');
        top.append(node('strong', `${index + 1}. ${step.label}`), node('span', `${step.targets.length} 个对象`)); row.append(top);
        row.append(node('p', step.targets.map(id => { const o = page.objects.find(o => o.id === id); return o ? `${o.name}${o.text ? `：${o.text.slice(0, 65)}` : ''}` : id; }).join(' / '), 'step-targets'));
        const fields = node('div', undefined, 'step-controls');
        fields.append(selectField('开始方式', step.trigger, [['auto', index ? '接着上一步' : '进入页面时'], ['click', '等待点击']], value => { step.trigger = value; page.policy = page.steps.some(s => s.trigger === 'click') ? 'steps' : 'auto'; renderInventory(); buttons(); }));
        fields.append(selectField('效果', step.effect, [['fade', '淡入'], ['rise', '轻移淡入'], ['wipe', '向上展开'], ['emphasis', '柔和强调'], ['appear', '直接出现']], value => { step.effect = value; }));
        const durationLabel = node('label', '时长（毫秒）', 'step-field'), duration = node('input'); duration.type = 'number'; duration.min = '200'; duration.max = '1800'; duration.step = '50'; duration.value = step.duration; duration.addEventListener('change', () => { step.duration = Number(duration.value); }); durationLabel.append(duration); fields.append(durationLabel); row.append(fields);
        const actions = node('div', undefined, 'step-actions');
        if (index) actions.append(action('上移', () => moveStep(page, index, -1), `上移第 ${index + 1} 步`));
        if (index + 1 < page.steps.length) actions.append(action('下移', () => moveStep(page, index, 1), `下移第 ${index + 1} 步`));
        if (index) actions.append(action('与上一步同时', () => mergeStep(page, index)));
        if (step.targets.length > 1) actions.append(action('拆出一个对象', () => splitStep(page, index)));
        actions.append(action('保持静态', () => page.steps.splice(index, 1))); row.append(actions); list.append(row);
      }); section.append(list);
      const used = new Set(page.steps.flatMap(s => s.targets)), remaining = page.objects.filter(o => o.eligible && !used.has(o.id));
      if (remaining.length) {
        const label = node('label', '添加静态对象到步骤', 'step-field'), select = node('select'); select.setAttribute('aria-label', `第 ${page.number} 页添加对象`); select.append(node('option', '选择对象…'));
        for (const o of remaining) { const option = node('option', `${o.name} ${o.text.slice(0, 50)}`); option.value = o.id; select.append(option); }
        select.addEventListener('change', () => { const o = remaining.find(o => o.id === select.value); if (!o) return; const key = `${page.number}-${o.id}-${Date.now()}`; page.steps.push({ id: key, label: (o.text || o.name).slice(0, 110), targets: [o.id], trigger: 'click', effect: 'fade', duration: 600 }); renderInventory(); buttons(); }); label.append(select); section.append(label);
      }
    }
    $('inventory').append(section);
  }
}
function refinePage(page, button) {
  work(async () => {
    animationController = new AbortController(); $('cancel-animation-ai').hidden = false;
    $('animation-ai-status').textContent = `正在优化第 ${page.number} 页，仅发送本页对象摘要…`; let chars = 0;
    try {
      const form = new FormData(); form.set('file', state.pptx); form.set('settings', JSON.stringify({ number: page.number, page: compactPage(page) }));
      const response = await api('/api/animation-plan/stream', { method: 'POST', body: form, signal: animationController.signal });
      let complete = false;
      for await (const event of readSse(response.body)) {
        const data = JSON.parse(event.data);
        if (event.type === 'delta') { chars += data.text.length; $('animation-ai-status').textContent = `第 ${page.number} 页已接收 ${chars} 字符…`; }
        if (event.type === 'error') throw new Error(data.error);
        if (event.type === 'completed') { if (data.page?.number !== page.number || !Array.isArray(data.page.steps)) throw new Error('动画方案不完整'); state.inventory.slides[page.number - 1] = data.page; complete = true; break; }
      }
      if (!complete) throw new Error('连接中断，原有步骤已保留');
      $('animation-ai-status').textContent = `第 ${page.number} 页已优化，其他页面保持原方案。`; renderInventory(); notice('本页步骤已更新，可继续调整后下载。');
    } catch (error) { $('animation-ai-status').textContent = '本次优化未完成，原有步骤已保留。'; if (animationController.signal.aborted) throw new Error('已停止 AI 优化，原方案已保留'); throw error; }
    finally { animationController = null; $('cancel-animation-ai').hidden = true; }
  }, '正在优化…', button);
}
$('cancel-animation-ai').addEventListener('click', () => animationController?.abort());
$('animate-button').addEventListener('click', () => work(async () => {
  if (!state.pptx || !state.inventory) throw new Error('请重新上传 PPTX');
  const form = new FormData(); form.set('file', state.pptx); form.set('plan', JSON.stringify(compactPlan(state.inventory)));
  const response = await api('/api/animate-native', { method: 'POST', body: form });
  const report = JSON.parse(decodeURIComponent(response.headers.get('x-animation-report')));
  await download(response, '动态演示.pptx'); $('animation-report').hidden = false;
  $('animation-report').textContent = `共 ${report.totalSlides} 页，为 ${report.animatedSlides} 页编排动画，${report.skippedSlides} 页保留。\n原始内容、布局、页序与内部引用已通过结构校验。\n页面由演讲者手动推进。PowerPoint 与 WPS 实际放映效果待你确认。`;
  notice('动态 PPTX 已下载。请在放映模式下按讲解步骤点击推进。');
}, '正在写入原生动画…', $('animate-button')));
async function init() {
  try {
    const config = await (await api('/api/config')).json();
    state.aiConfigured = config.aiConfigured;
    $('model-label').textContent = config.aiConfigured ? config.model : '模型未配置';
    $('config-button').classList.toggle('connected', config.aiConfigured);
    $('ai-option').disabled = !config.aiConfigured; $('ai-option').textContent = config.aiConfigured ? 'AI 编排' : 'AI 编排（未配置）';
    if (config.aiConfigured) { $('generation-mode').value = 'ai'; $('generation-mode').dispatchEvent(new Event('change')); }
    $('config-description').textContent = config.aiConfigured ? `当前模型：${config.model}。AI 编排使用流式输出，页面内容会逐页出现。` : '当前可使用原文分页。配置模型后，可使用 AI 整理重点与提纲。';
  } catch { $('model-label').textContent = '服务连接失败'; notice('无法连接本地服务，请检查终端中的启动状态。', true); }
}
buttons(); init().then(buttons);
if (location.hash === '#motion') stage('motion');
