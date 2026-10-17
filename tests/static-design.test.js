import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { validateDeck, structureText } from '../src/outline.js';
import { layoutSlide, validateGeometry } from '../public/layout.js';
import { generatePptx } from '../src/presentation.js';
import { planAnimations, applyAnimationPlan } from '../src/animation.js';
import { parseXml, descendants, NS } from '../src/package.js';

import { readFileSync } from 'node:fs';
const designDeck = JSON.parse(readFileSync(new URL('../public/design-example.json', import.meta.url), 'utf8'));

test('structured slide content survives validation and exports as independent editable text', async () => {
  const deck = validateDeck(designDeck);
  assert.equal(deck.slides[2].items[0].heading, '可编辑');
  const zip = await JSZip.loadAsync(await generatePptx(deck));
  for (let i = 0; i < deck.slides.length; i++) {
    const doc = parseXml(await zip.file(`ppt/slides/slide${i + 1}.xml`).async('string'));
    const text = descendants(doc, NS.a, 't').map(n => n.textContent);
    for (const item of deck.slides[i].items || []) for (const value of Object.values(item)) assert.ok(text.includes(value), value);
    if (deck.slides[i].takeaway) assert.ok(text.includes(deck.slides[i].takeaway));
    assert.equal(descendants(doc, NS.p, 'pic').length, 0, 'native layouts must not become slide images');
  }
});
test('ambiguous mixed content and metrics without actual values fail with useful errors', () => {
  assert.throws(() => validateDeck({ title: '标题', slides: [{ title: '内容', bullets: ['旧内容'], items: [{ heading: '新内容', body: '说明' }] }] }), /正文|items|bullets/);
  assert.throws(() => validateDeck({ title: '标题', slides: [{ title: '指标', layout: 'metrics', items: [{ heading: '数量', body: '未提供数值' }] }] }), /数值|value/);
});
test('parallel cards use distinct heading/body zones and process steps form a horizontal timeline', () => {
  const cards = layoutSlide(designDeck.slides[2], 3);
  assert.equal(cards.filter(o => o.role === 'item-heading').length, 3);
  assert.equal(cards.filter(o => o.role === 'body').length, 3);
  assert.equal(new Set(cards.filter(o => o.role === 'body').map(o => o.y)).size, 1);
  const process = layoutSlide(designDeck.slides[4], 5), bodies = process.filter(o => o.role === 'body');
  assert.equal(new Set(bodies.map(o => o.y)).size, 1);
  assert.equal(new Set(bodies.map(o => o.x)).size, 3);
  assert.ok(process.some(o => o.kind === 'ellipse'));
  for (const obj of process.filter(o => o.role === 'body')) assert.ok(process.some(o => o.role === 'marker' && o.group === obj.group));
});
test('native numeric highlights do not invent data or convert it into chart images', () => {
  const objects = layoutSlide(designDeck.slides[5], 6);
  assert.deepEqual(objects.filter(o => o.role === 'value').map(o => o.text), ['2', '1–30', '0']);
  assert.ok(objects.filter(o => o.role === 'value').every(o => o.size >= 38));
});
test('all layouts fit all themes without text overlaps or missing source content', async () => {
  for (const [i, slide] of designDeck.slides.entries()) {
    const objects = layoutSlide(slide, i + 1);
    validateGeometry(objects, i + 1);
    for (const item of slide.items || []) for (const value of Object.values(item)) assert.ok(objects.some(o => o.text === value));
  }
  for (const theme of ['studio', 'ink', 'night']) await generatePptx(designDeck, { theme });
});
test('source pagination selects content-appropriate layouts and retains the original sentences', () => {
  const deck = structureText('# 方案\n## 实施流程\n第一步：核对需求\n第二步：完成交付\n## 两种方案对比\n方案一说明\n方案二说明\n## 总结\n由演讲者控制节奏');
  assert.deepEqual(deck.slides.map(s => s.layout), ['cover', 'process', 'comparison', 'summary']);
  assert.deepEqual(deck.slides.slice(1).flatMap(s => s.bullets), ['第一步：核对需求', '第二步：完成交付', '方案一说明', '方案二说明', '由演讲者控制节奏']);
});
test('new static templates retain slide content through native animation processing', async () => {
  const input = await generatePptx(designDeck), plan = await planAnimations(input);
  assert.equal(plan.slides.length, 8);
  assert.equal(plan.slides[4].policy, 'steps');
  assert.equal(plan.slides[5].layout, 'metrics');
  assert.equal(plan.slides[2].steps.filter(s => s.targets.length >= 3).length, 3);
  const result = await applyAnimationPlan(input, plan);
  assert.equal(result.report.totalSlides, 8);
  assert.equal(result.report.structuralValidation.passed, true);
  assert.equal(result.report.powerPointPlaybackValidated, false);
  assert.equal(result.report.wpsPlaybackValidated, false);
});
