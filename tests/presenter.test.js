import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as animation from '../src/animation.js';
import { planDeck } from '../src/outline.js';
import { generatePptx } from '../src/presentation.js';
import { parseXml, serialize, descendants, NS } from '../src/package.js';

const layouts = ['cover', 'chapter', 'cards', 'comparison', 'process', 'summary'];
export const presenterDeck = { title: '项目方案', slides: layouts.map((layout, i) => ({ title: ['项目方案', '实施计划', '方案构成', '两种方案对比', '交付流程', '总结'][i], layout, subtitle: i === 0 ? '内容由演讲者推进' : undefined, bullets: layout === 'cover' || layout === 'chapter' ? [] : ['第一项内容', '第二项内容', '第三项内容'], notes: '保留讲稿' })) };
const model = { baseUrl: 'http://fixture/v1', model: 'configured' };
function provider(deck, observe = () => {}) { return async (_, options) => { observe(JSON.parse(options.body)); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(deck) } }] })); }; }
const bytes = z => z.generateAsync({ type: 'nodebuffer' });

test('explicit AI page count is enforced instead of accepting an arbitrary model result', async () => {
  await assert.rejects(() => planDeck('主题', { mode: 'ai', slideCount: 5, config: model, fetchImpl: provider({ title: '主题', slides: [{ title: '主题', bullets: [] }] }) }), /页数/);
});
test('optional page count lets AI choose and explains layouts in its prompt', async () => {
  let prompt;
  const result = await planDeck('主题', { mode: 'ai', config: model, fetchImpl: provider(presenterDeck, body => { prompt = body.messages[0].content; }) });
  assert.equal(result.deck.slides.length, 6); assert.match(prompt, /自行|根据内容/); assert.match(prompt, /comparison/);
});
test('source pagination refuses a conflicting page count instead of dropping material', async () => {
  await assert.rejects(() => planDeck('# 主题\n## 章节\n内容', { mode: 'source', slideCount: 4 }), /页数|AI/);
});
test('six editable layouts have stable object metadata and bounded nonoverlapping text', async () => {
  const z = await JSZip.loadAsync(await generatePptx(presenterDeck));
  const positions = [];
  for (let i = 1; i <= 6; i++) {
    const doc = parseXml(await z.file(`ppt/slides/slide${i}.xml`).async('string'));
    assert.equal(descendants(doc, NS.p, 'timing').length, 0);
    assert.equal(descendants(doc, NS.p, 'cSld')[0].getAttribute('name'), `llmpptx:layout:${layouts[i - 1]}`);
    const shapes = descendants(doc, NS.p, 'sp'); const texts = [];
    for (const shape of shapes) {
      const meta = JSON.parse(descendants(shape, NS.p, 'cNvPr')[0].getAttribute('descr'));
      assert.match(meta.stableId, /^s\d+-/); assert.ok(meta.group);
      const transform = descendants(shape, NS.a, 'xfrm')[0];
      const off = descendants(transform, NS.a, 'off')[0], ext = descendants(transform, NS.a, 'ext')[0];
      const box = { x: +off.getAttribute('x'), y: +off.getAttribute('y'), w: +ext.getAttribute('cx'), h: +ext.getAttribute('cy') };
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= 12192010 && box.y + box.h <= 6858010);
      if (descendants(shape, NS.a, 't').length) texts.push(box);
    }
    for (let a = 0; a < texts.length; a++) for (let b = a + 1; b < texts.length; b++) {
      const x = Math.min(texts[a].x + texts[a].w, texts[b].x + texts[b].w) - Math.max(texts[a].x, texts[b].x);
      const y = Math.min(texts[a].y + texts[a].h, texts[b].y + texts[b].h) - Math.max(texts[a].y, texts[b].y);
      assert.ok(x <= 1 || y <= 1, `overlap on slide ${i}`);
    }
    positions.push(texts.slice(1).map(t => [t.x, t.y]));
  }
  assert.notDeepEqual(positions[2], positions[3]); assert.notDeepEqual(positions[3], positions[4]);
});
test('presenter plan groups related shapes, mixes automatic and click steps, and never expands pages', async () => {
  assert.equal(typeof animation.planAnimations, 'function');
  const input = await generatePptx(presenterDeck), plan = await animation.planAnimations(input);
  assert.equal(plan.slides.length, 6); assert.equal(plan.slides[0].steps[0].trigger, 'auto');
  assert.ok(plan.slides[4].steps.filter(s => s.trigger === 'click').length >= 3);
  assert.ok(plan.slides[4].steps.some(s => s.targets.length > 1));
  const result = await animation.applyAnimationPlan(input, plan), z = await JSZip.loadAsync(result.buffer), before = await JSZip.loadAsync(input);
  assert.equal((await animation.inspectPptx(result.buffer)).slides.length, 6);
  for (let i = 1; i <= 6; i++) {
    const name = `ppt/slides/slide${i}.xml`, doc = parseXml(await z.file(name).async('string'));
    assert.equal(serialize(descendants(doc, NS.p, 'cSld')[0]), serialize(descendants(parseXml(await before.file(name).async('string')), NS.p, 'cSld')[0]));
    assert.ok(descendants(doc, NS.p, 'transition').every(t => t.getAttribute('advClick') === '1' && !t.hasAttribute('advTm')));
    assert.equal(descendants(doc, NS.p, 'video').length, 0);
  }
  assert.equal(result.report.powerPointPlaybackValidated, false); assert.equal(result.report.wpsPlaybackValidated, false);
  assert.ok(result.report.structuralValidation.passed);
});
test('manual additions and renames use actual geometry; a stale plan fails safely', async () => {
  assert.equal(typeof animation.planAnimations, 'function');
  const input = await generatePptx(presenterDeck), oldPlan = await animation.planAnimations(input), z = await JSZip.loadAsync(input);
  let xml = await z.file('ppt/slides/slide5.xml').async('string');
  xml = xml.replace('name="正文 1"', 'name="用户重命名"').replace('第一项内容', '人工修改后的流程');
  const shape = /<p:sp>[\s\S]*?<\/p:sp>/.exec(xml)[0].replace(/id="\d+"/, 'id="88"').replace(/descr="[^"]*"/, '').replace('交付流程', '新增说明');
  z.file('ppt/slides/slide5.xml', xml.replace('</p:spTree>', shape + '</p:spTree>'));
  const edited = await bytes(z), plan = await animation.planAnimations(edited);
  assert.ok(plan.slides[4].objects.some(o => o.id === '88'));
  assert.ok(plan.slides[4].objects.some(o => o.name === '用户重命名' && o.text.includes('人工修改')));
  await assert.rejects(() => animation.applyAnimationPlan(edited, oldPlan), /文件|重新|变化/);
  await animation.applyAnimationPlan(edited, plan);
});
test('native plans preserve existing timelines by default and reject deleted/duplicate targets', async () => {
  assert.equal(typeof animation.planAnimations, 'function');
  const input = await generatePptx(presenterDeck), first = await animation.applyAnimationPlan(input, await animation.planAnimations(input));
  const repeated = await animation.planAnimations(first.buffer);
  assert.ok(repeated.slides.every(s => s.policy === 'preserve'));
  const again = await animation.applyAnimationPlan(first.buffer, repeated);
  assert.equal(again.report.animatedSlides, 0);
  const one = await JSZip.loadAsync(first.buffer), two = await JSZip.loadAsync(again.buffer);
  assert.equal(await one.file('ppt/slides/slide5.xml').async('string'), await two.file('ppt/slides/slide5.xml').async('string'));
  const plan = await animation.planAnimations(input); plan.slides[1].steps[0].targets = ['99999'];
  await assert.rejects(() => animation.applyAnimationPlan(input, plan), /对象|不存在/);
});
