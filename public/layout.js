// Shared native-object geometry. Core frames adapted from ppt-master's MIT templates.
// See third_party/ppt-master/LICENSE and docs/open-source-design.md.
import { coreTemplates } from './core-templates.js';
export const slideSize = { width: 13.333333, height: 7.5 };
export const layoutLabels = { cover: '封面', chapter: '章节', content: '分栏解释', cards: '观点卡片', comparison: '双栏对比', process: '流程时间线', metrics: '数字重点', statement: '观点大字', summary: '总结与行动' };
export const themes = {
  studio: { bg: 'F8FAFD', ink: '182D4D', accent: '245BD7', rule: 'D9E1EE', panel: 'EDF2FA', muted: '536782', soft: 'DDE8FF', onAccent: 'FFFFFF', font: 'Microsoft YaHei' },
  ink: { bg: 'FCFAF5', ink: '243731', accent: '286553', rule: 'D8E0D8', panel: 'EFF0E8', muted: '566B60', soft: 'DEEBDE', onAccent: 'FFFFFF', font: 'Microsoft YaHei' },
  night: { bg: '142237', ink: 'F2F5FC', accent: '9ABEFF', rule: '354961', panel: '20344C', muted: 'B1C3D9', soft: '2B4666', onAccent: '142237', font: 'Microsoft YaHei' },
};
export function textHeight(text, width, size) {
  const capacity = width * 72 / (size * 1.08);
  const lines = text.split(/\r?\n/).reduce((n, line) => {
    const units = [...line].reduce((sum, c) => sum + (/[^\u0000-\u00ff]/u.test(c) ? 1 : /[MW@#%&]/.test(c) ? .95 : /\s/.test(c) ? .35 : .62), 0);
    return n + Math.max(1, Math.ceil(units / capacity));
  }, 0);
  return lines * size * 1.28 / 72 + .1;
}
function fit(text, w, h, preferred, page, min = 17) {
  for (let size = preferred; size >= min; size--) if (textHeight(text, w, size) <= h + .001) return size;
  throw new Error(`第 ${page} 页文字过多，无法容纳，请缩短内容或更换布局`);
}
const M = 64 / 96, W = 1152 / 96, B = 6.67;
export function layoutSlide(data, page = 1) {
  const objects = [], layout = data.layout || 'content';
  const items = data.items?.length ? data.items : (data.bullets || []).map(body => ({ body }));
  const addText = (key, text, x, y, w, h, size, role, group, color = 'ink', bold = false, extra = {}) => {
    if (!text) return;
    objects.push({ key, kind: 'text', text, x, y, w, h, size: fit(text, w, h, size, page, role === 'decoration' || role === 'number' ? 10 : 17), role, group, color, bold, valign: 'top', ...extra });
  };
  const shape = (key, x, y, w, h, role, group, color = 'panel', kind = 'rect') => objects.push({ key, kind, x, y, w, h, role, group, color });
  const finish = () => {
    shape('footer-rule', M, 7.04, W, .012, 'decoration', 'footer', 'rule');
    objects.push({ key: 'page-number', kind: 'text', text: String(page).padStart(2, '0'), x: 11.98, y: 7.12, w: .65, h: .23, size: 10, role: 'decoration', group: 'footer', color: 'muted', align: 'right' });
    validateGeometry(objects, page); return objects;
  };
  const label = (y = .26) => addText('eyebrow', data.eyebrow, M, y, W, .34, 11, 'decoration', 'footer', 'accent', true);
  const header = () => {
    const titleY = data.eyebrow ? .83 : .55;
    const titleH = Math.max(.72, textHeight(data.title, W, 32));
    addText('title', data.title, M, titleY, W, titleH, 32, 'title', 'heading', 'ink', true);
    label();
    let bottom = titleY + titleH;
    if (data.subtitle) {
      const h = Math.max(.43, textHeight(data.subtitle, W, 18));
      addText('subtitle', data.subtitle, M, bottom + .12, W, h, 18, 'subtitle', 'heading', 'muted'); bottom += .12 + h;
    }
    return Math.max(1.75, bottom + .34);
  };
  const takeaway = () => {
    if (!data.takeaway) return B;
    const h = Math.max(.55, textHeight(data.takeaway, W - .5, 20)), y = B - h;
    shape('takeaway-panel', M, y - .06, W, h + .12, 'panel', 'takeaway', 'soft');
    addText('takeaway', data.takeaway, M + .25, y, W - .5, h, 20, 'takeaway', 'takeaway', 'ink', true);
    return y - .34;
  };
  const itemText = (item, i, x, y, w, h, preferred = 22) => {
    const group = `item-${i + 1}`;
    let offset = 0;
    if (item.value) {
      const valueH = Math.max(.75, textHeight(item.value, w, 38));
      addText(`value-${i + 1}`, item.value, x, y, w, valueH, 38, 'value', group, 'accent', true); offset += valueH + .15;
    }
    if (item.heading) {
      const headingH = Math.max(.46, textHeight(item.heading, w, 23));
      addText(`item-heading-${i + 1}`, item.heading, x, y + offset, w, headingH, 23, 'item-heading', group, 'ink', true); offset += headingH + .13;
    }
    addText(`body-${i + 1}`, item.body, x, y + offset, w, h - offset, preferred, 'body', group, item.heading ? 'muted' : 'ink');
  };
  // Dense material retains its original sentences in full-width rows. No truncation.
  const bands = (top, bottom) => {
    let size = 22, heights;
    for (; size >= 17; size--) {
      heights = items.map(item => (item.heading ? textHeight(item.heading, W - .65, 20) + .1 : 0) + (item.value ? textHeight(item.value, W - .65, 24) + .1 : 0) + (item.body ? textHeight(item.body, W - .65, size) : .1));
      if (heights.reduce((a, b) => a + b, 0) + (items.length - 1) * .2 <= bottom - top) break;
    }
    if (size < 17) throw new Error(`第 ${page} 页正文过多，请缩短说明、增加页数或更换布局`);
    let y = top;
    items.forEach((item, i) => {
      const group = `item-${i + 1}`, h = heights[i];
      shape(`row-rule-${i + 1}`, M, y + .04, .035, Math.max(.22, h - .08), 'marker', group, 'accent');
      let offset = 0;
      if (item.value) { const v = textHeight(item.value, W - .65, 24); addText(`value-${i + 1}`, item.value, M + .25, y, W - .65, v, 24, 'value', group, 'accent', true); offset += v + .1; }
      if (item.heading) { const hh = textHeight(item.heading, W - .65, 20); addText(`item-heading-${i + 1}`, item.heading, M + .25, y + offset, W - .65, hh, 20, 'item-heading', group, 'ink', true); offset += hh + .1; }
      addText(`body-${i + 1}`, item.body, M + .25, y + offset, W - .65, h - offset, size, 'body', group, item.heading ? 'muted' : 'ink'); y += h + .2;
    });
  };
  if (['cover', 'chapter', 'statement'].includes(layout) && !items.length) {
    const slot = coreTemplates.title_slide.slots['title-slide-title'];
    const y = layout === 'statement' ? 1.85 : slot.y;
    const h = Math.max(1.65, textHeight(data.title, slot.w, 46));
    addText('title', data.title, slot.x, y, slot.w, h, 46, 'title', 'heading', 'ink', true);
    shape('hero-accent', M, y, .065, Math.min(2.25, h + .6), 'decoration', 'footer', 'accent');
    addText('eyebrow', data.eyebrow, slot.x, y - .72, slot.w, .36, 12, 'decoration', 'footer', 'accent', true);
    if (data.subtitle) {
      const sh = Math.max(.65, textHeight(data.subtitle, 10, 22));
      addText('subtitle', data.subtitle, slot.x, y + h + .25, 10, sh, 22, 'subtitle', 'heading', 'muted');
    }
    takeaway(); return finish();
  }
  // Editorial split: claim on the left, structured support on the right.
  if (layout === 'content' && items.length) {
    const titleSlot = coreTemplates.editorial_split.slots['editorial-split-title'];
    const right = coreTemplates.editorial_split.panels[0], top = .95;
    const need = items.reduce((sum, item) => sum + (item.heading ? textHeight(item.heading, right.w - .65, 23) + .16 : 0) + (item.value ? textHeight(item.value, right.w - .65, 38) + .15 : 0) + (item.body ? textHeight(item.body, right.w - .65, 21) : .1), 0) + (items.length - 1) * .3;
    if (!data.takeaway && need <= B - top - .5 && data.title.length <= 30 && (!data.subtitle || data.subtitle.length <= 80)) {
      const h = Math.max(1.4, textHeight(data.title, titleSlot.w, 34));
      addText('title', data.title, M, 1.3, titleSlot.w, h, 34, 'title', 'heading', 'ink', true);
      label(.5);
      addText('subtitle', data.subtitle, M, 1.3 + h + .3, titleSlot.w, Math.max(.5, textHeight(data.subtitle || '', titleSlot.w, 20)), 20, 'subtitle', 'heading', 'muted');
      shape('split-rail', 5.75, top, .018, B - top, 'decoration', 'footer', 'rule');
      let y = top + .2;
      const extra = Math.max(0, (B - top - .5 - need) / items.length);
      items.forEach((item, i) => {
        const h = (item.heading ? textHeight(item.heading, right.w - .65, 23) + .16 : 0) + (item.value ? textHeight(item.value, right.w - .65, 38) + .15 : 0) + (item.body ? textHeight(item.body, right.w - .65, 21) : .1) + extra;
        itemText(item, i, right.x + .25, y, right.w - .65, h, 21);
        y += h + .3;
      });
      return finish();
    }
  }
  const top = header(), bottom = takeaway(), available = bottom - top;
  if (available < .3 && items.length) throw new Error(`第 ${page} 页标题或副标题过长，请缩短内容`);
  if (!items.length) return finish();
  if (layout === 'cards' || layout === 'comparison') {
    const columns = layout === 'comparison' ? 2 : items.length === 4 ? 2 : Math.min(3, items.length), rows = Math.ceil(items.length / columns), gap = .25;
    const prototype = layout === 'comparison' ? coreTemplates.comparison : coreTemplates.three_card;
    const frame = prototype.panels[0];
    const w = (W - (columns - 1) * gap) / columns, h = (available - (rows - 1) * gap) / rows;
    const panelFits = items.every(item => {
      const need = (item.heading ? textHeight(item.heading, w - .6, 23) + .13 : 0) + (item.value ? textHeight(item.value, w - .6, 38) + .15 : 0) + (item.body ? textHeight(item.body, w - .6, 17) : .1);
      return need <= h - .96;
    });
    if (!panelFits) bands(top, bottom);
    else items.forEach((item, i) => {
      const x = frame.x + i % columns * (w + gap), y = top + Math.floor(i / columns) * (h + gap), group = `item-${i + 1}`;
      shape(`panel-${i + 1}`, x, y, w, h, 'panel', group, i === 1 && layout === 'comparison' ? 'soft' : 'panel');
      shape(`card-accent-${i + 1}`, x + .3, y + .3, .33, .035, 'marker', group, 'accent');
      addText(`number-${i + 1}`, String(i + 1).padStart(2, '0'), x + w - .85, y + .22, .55, .3, 11, 'number', group, 'accent', true, { align: 'right' });
      itemText(item, i, x + .3, y + .76, w - .6, h - .98, 22);
    });
  } else if (layout === 'process') {
    const gap = .28, w = (W - gap * (items.length - 1)) / items.length, bodyH = available - 1.18;
    const horizontal = items.every(item => (item.heading ? textHeight(item.heading, w - .12, 23) + .13 : 0) + (item.body ? textHeight(item.body, w - .12, 17) : .1) <= bodyH);
    if (!horizontal) bands(top, bottom);
    else items.forEach((item, i) => {
      const x = M + i * (w + gap), cx = x + w / 2, group = `item-${i + 1}`, nodeY = top + .2;
      if (i) shape(`connector-${i + 1}`, cx - w - gap + .26, nodeY + .25, w + gap - .52, .025, 'connector', group, 'rule');
      shape(`marker-${i + 1}`, cx - .26, nodeY, .52, .52, 'marker', group, 'accent', 'ellipse');
      addText(`number-${i + 1}`, String(i + 1), cx - .19, nodeY + .08, .38, .35, 16, 'number', group, 'onAccent', true, { align: 'center' });
      itemText(item, i, x + .06, top + 1.06, w - .12, bodyH, 21);
    });
  } else if (layout === 'metrics') {
    const gap = .25, w = (W - gap * (items.length - 1)) / items.length;
    items.forEach((item, i) => {
      const x = M + i * (w + gap), group = `item-${i + 1}`;
      shape(`panel-${i + 1}`, x, top, w, available, 'panel', group);
      addText(`value-${i + 1}`, item.value, x + .24, top + .4, w - .48, 1.2, 46, 'value', group, 'accent', true);
      const hh = Math.max(.65, textHeight(item.heading, w - .48, 23));
      addText(`item-heading-${i + 1}`, item.heading, x + .24, top + 1.86, w - .48, hh, 23, 'item-heading', group, 'ink', true);
      addText(`body-${i + 1}`, item.body, x + .24, top + 2.04 + hh, w - .48, available - 2.28 - hh, 20, 'body', group, 'muted');
    });
  } else bands(top, bottom);
  return finish();
}
export function validateGeometry(objects, page = 1) {
  for (const o of objects) if (![o.x, o.y, o.w, o.h].every(Number.isFinite) || o.x < 0 || o.y < 0 || o.w <= 0 || o.h <= 0 || o.x + o.w > slideSize.width + .001 || o.y + o.h > slideSize.height + .001) throw new Error(`第 ${page} 页对象超出画布`);
  const text = objects.filter(o => o.kind === 'text');
  for (let a = 0; a < text.length; a++) for (let b = a + 1; b < text.length; b++) {
    const x = Math.min(text[a].x + text[a].w, text[b].x + text[b].w) - Math.max(text[a].x, text[b].x);
    const y = Math.min(text[a].y + text[a].h, text[b].y + text[b].h) - Math.max(text[a].y, text[b].y);
    if (x > .005 && y > .005) throw new Error(`第 ${page} 页文本框重叠，请缩短文字或更换布局`);
  }
}
