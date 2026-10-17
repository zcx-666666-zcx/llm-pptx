import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { layoutSlide } from '../public/layout.js';
import { moveStep, mergeStep, splitStep, compactPlan } from '../public/steps.js';
import { generatePptx } from '../src/presentation.js';
import { planAnimations, applyAnimationPlan, refineAnimationPage, validateAnimatedPptx } from '../src/animation.js';
import { parseXml, serialize, descendants, NS } from '../src/package.js';
const deck = { title: '实施流程', slides: [{ title: '实施流程', layout: 'process', bullets: ['准备工作', '实施与交付'] }] };
const zipBytes = z => z.generateAsync({ type: 'nodebuffer' });
test('dense card/compare content can fit at readable font sizes without losing text', async () => {
  for (const layout of ['cards', 'comparison']) {
    const bullets = Array.from({ length: 5 }, () => '这是需要完整保留的正文描述'.repeat(6));
    const result = layoutSlide({ title: '方案构成', layout, bullets });
    assert.deepEqual(result.filter(o => o.role === 'body').map(o => o.text), bullets);
    assert.ok(result.filter(o => o.role === 'body').every(o => o.size >= 17));
  }
});
test('changing a page to all-auto or all-click is reflected by compiled click gates', async () => {
  const input = await generatePptx(deck), plan = await planAnimations(input);
  for (const trigger of ['auto', 'click']) {
    plan.slides[0].steps.forEach(s => { s.trigger = trigger; });
    const z = await JSZip.loadAsync((await applyAnimationPlan(input, compactPlan(plan))).buffer);
    const doc = parseXml(await z.file('ppt/slides/slide1.xml').async('string'));
    const clickGates = descendants(doc, NS.p, 'cond').filter(n => n.getAttribute('delay') === 'indefinite');
    assert.equal(clickGates.length, trigger === 'click' ? plan.slides[0].steps.length : 0);
    const timingIds = descendants(doc, NS.p, 'cTn').map(n => n.getAttribute('id'));
    assert.equal(new Set(timingIds).size, timingIds.length);
    assert.ok(descendants(doc, NS.p, 'animEffect').length);
  }
});
test('step editing merges/splits object groups without losing or duplicating targets', async () => {
  const input = await generatePptx(deck), plan = await planAnimations(input), page = plan.slides[0];
  const targets = page.steps.flatMap(s => s.targets).sort();
  moveStep(page, 2, -1); mergeStep(page, 1); splitStep(page, 0);
  assert.deepEqual(page.steps.flatMap(s => s.targets).sort(), targets);
  assert.equal(new Set(page.steps.map(s => s.id)).size, page.steps.length);
  await applyAnimationPlan(input, compactPlan(plan));
});
test('existing effect timelines survive while imported automatic advance and kiosk loop are disabled', async () => {
  const input = await generatePptx(deck), first = await applyAnimationPlan(input, await planAnimations(input));
  const z = await JSZip.loadAsync(first.buffer);
  const file = 'ppt/slides/slide1.xml'; let xml = await z.file(file).async('string');
  xml = xml.replace('advClick="1"', 'advClick="0" advTm="200"'); z.file(file, xml);
  const propsFile = 'ppt/presProps.xml', props = await z.file(propsFile).async('string');
  z.file(propsFile, props.replace('loop="0"', 'loop="1"').replace('useTimings="0"', 'useTimings="1"').replace('<p:present/>', '<p:kiosk restart="1000"/>'));
  const edited = await zipBytes(z), plan = await planAnimations(edited);
  const result = await applyAnimationPlan(edited, plan), after = await JSZip.loadAsync(result.buffer);
  const beforeDoc = parseXml(xml), afterDoc = parseXml(await after.file(file).async('string'));
  assert.equal(serialize(descendants(beforeDoc, NS.p, 'timing')[0]), serialize(descendants(afterDoc, NS.p, 'timing')[0]));
  const show = parseXml(await after.file(propsFile).async('string'));
  assert.equal(descendants(show, NS.p, 'kiosk').length, 0); assert.equal(descendants(show, NS.p, 'showPr')[0].getAttribute('useTimings'), '0');
  assert.ok(descendants(afterDoc, NS.p, 'transition').every(n => !n.hasAttribute('advTm')));
});
test('groups and images use whole-object effects; native tables and opaque shapes stay conservative', async () => {
  const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE'; const slide = pptx.addSlide();
  slide.addText('内容', { x: 1, y: 1, w: 3, h: .6 });
  slide.addImage({ data: 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', x: 1, y: 3, w: 1, h: 1 });
  slide.addShape(pptx.ShapeType.rect, { x: 3, y: 3, w: 1, h: 1 });
  slide.addTable([['分类', '进度']], { x: 5, y: 3, w: 3, h: .6 });
  const z = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  let xml = await z.file('ppt/slides/slide1.xml').async('string'); xml = xml.replace(/(<p:cNvPr id=")\d+(" name="Table)/, '$177$2');
  z.file('ppt/slides/slide1.xml', xml); const input = await zipBytes(z), plan = await planAnimations(input);
  assert.ok(plan.slides[0].objects.some(o => o.type === 'pic' && o.eligible));
  assert.ok(plan.slides[0].objects.some(o => o.type === 'graphicFrame' && !o.eligible));
  assert.ok(plan.slides[0].warnings.some(w => w.includes('复杂对象')));
  await applyAnimationPlan(input, plan);
});
test('deleted objects and broken relationships are caught before returning a download', async () => {
  const input = await generatePptx(deck), z = await JSZip.loadAsync(input);
  const xml = await z.file('ppt/slides/slide1.xml').async('string');
  z.file('ppt/slides/slide1.xml', xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/, ''));
  const edited = await zipBytes(z), plan = await planAnimations(edited); await applyAnimationPlan(edited, plan);
  const relation = 'ppt/slides/_rels/slide1.xml.rels';
  z.file(relation, (await z.file(relation).async('string')).replace('../slideLayouts/slideLayout1.xml', '../slideLayouts/missing.xml'));
  const broken = await zipBytes(z); await assert.rejects(() => planAnimations(broken).then(p => applyAnimationPlan(broken, p)), /关系/);
});
test('moving objects use easing; emphasis restores the original opacity', async () => {
  const input = await generatePptx({ title: '内容', slides: [{ title: '内容', bullets: ['重点内容'] }] }), plan = await planAnimations(input);
  const body = plan.slides[0].steps.at(-1); body.effect = 'rise';
  plan.slides[0].steps.push({ ...body, id: 'emphasis', effect: 'emphasis', trigger: 'click' });
  const z = await JSZip.loadAsync((await applyAnimationPlan(input, plan)).buffer), doc = parseXml(await z.file('ppt/slides/slide1.xml').async('string'));
  const motion = descendants(doc, NS.p, 'animMotion')[0]; assert.ok(motion);
  const timing = descendants(motion, NS.p, 'cTn')[0]; assert.ok(+timing.getAttribute('decel') > 0);
  assert.ok(+timing.getAttribute('accel') + +timing.getAttribute('decel') <= 100000);
  const emphasis = descendants(doc, NS.p, 'anim')[0], values = descendants(emphasis, NS.p, 'fltVal').map(n => n.getAttribute('val'));
  assert.equal(values[0], '1'); assert.equal(values.at(-1), '1');
});
test('cloned shape metadata does not merge distinct copied objects into one semantic identity', async () => {
  const input = await generatePptx(deck), z = await JSZip.loadAsync(input), file = 'ppt/slides/slide1.xml';
  let xml = await z.file(file).async('string'); const shape = /<p:sp>[\s\S]*?<\/p:sp>/.exec(xml)[0].replace(/id="\d+"/, 'id="88"');
  z.file(file, xml.replace('</p:spTree>', shape + '</p:spTree>'));
  const plan = await planAnimations(await zipBytes(z)), copied = plan.slides[0].objects.filter(o => o.id === '88' || o.name === '标题');
  assert.ok(copied.some(o => !o.stableId)); assert.ok(plan.slides[0].warnings.some(w => /重复|复制/.test(w)));
});
test('key-point pages wait for the speaker even when their layout is ordinary content', async () => {
  const input = await generatePptx({ title: '实施重点', slides: [{ title: '实施重点', layout: 'content', bullets: ['职责确认', '风险复核'] }] });
  const plan = await planAnimations(input);
  assert.equal(plan.slides[0].policy, 'steps');
  assert.deepEqual(plan.slides[0].steps.map(s => s.trigger), ['auto', 'click', 'click']);
});
test('splitting a legal maximum-length step ID still produces exportable unique IDs', async () => {
  const input = await generatePptx(deck), plan = await planAnimations(input), page = plan.slides[0];
  page.steps[1].id = 'x'.repeat(80); splitStep(page, 1);
  assert.ok(page.steps.every(s => s.id.length <= 80));
  assert.equal(new Set(page.steps.map(s => s.id)).size, page.steps.length);
  await applyAnimationPlan(input, compactPlan(plan));
});
test('generated animation precedes a compatibility-wrapped slide extension list', async () => {
  const input = await generatePptx(deck), z = await JSZip.loadAsync(input), file = 'ppt/slides/slide1.xml';
  const xml = await z.file(file).async('string');
  z.file(file, xml.replace('</p:sld>', '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><mc:Choice Requires="p14"><p:extLst><p:ext uri="test-extension"/></p:extLst></mc:Choice><mc:Fallback><p:extLst/></mc:Fallback></mc:AlternateContent></p:sld>'));
  const source = await zipBytes(z), result = await applyAnimationPlan(source, await planAnimations(source)), out = await JSZip.loadAsync(result.buffer);
  const doc = parseXml(await out.file(file).async('string')), children = [...doc.documentElement.childNodes].filter(n => n.nodeType === 1).map(n => n.localName);
  assert.ok(children.indexOf('transition') < children.indexOf('timing'));
  assert.ok(children.indexOf('timing') < children.indexOf('AlternateContent'));
  assert.ok(descendants(doc, NS.p, 'ext').some(n => n.getAttribute('uri') === 'test-extension'));
});
test('native animation export enables showAnimation when source disabled animation playback', async () => {
  const input = await generatePptx(deck), z = await JSZip.loadAsync(input), file = 'ppt/presProps.xml';
  const xml = await z.file(file).async('string');
  const props = parseXml(xml); let show = descendants(props, NS.p, 'showPr')[0];
  if (!show) { show = props.createElementNS(NS.p, 'p:showPr'); props.documentElement.appendChild(show); }
  show.setAttribute('showAnimation', '0'); z.file(file, serialize(props));
  const source = await zipBytes(z), result = await applyAnimationPlan(source, await planAnimations(source)), out = await JSZip.loadAsync(result.buffer);
  const doc = parseXml(await out.file(file).async('string'));
  assert.equal(descendants(doc, NS.p, 'showPr')[0].getAttribute('showAnimation'), '1');
});

test('structural validator rejects timing after extensions and disabled animation playback', async () => {
  const input = await generatePptx(deck), result = await applyAnimationPlan(input, await planAnimations(input));
  const z = await JSZip.loadAsync(result.buffer), file = 'ppt/slides/slide1.xml';
  const doc = parseXml(await z.file(file).async('string')), timing = descendants(doc, NS.p, 'timing')[0];
  const ext = doc.createElementNS(NS.p, 'p:extLst'); doc.documentElement.insertBefore(ext, timing); z.file(file, serialize(doc));
  const invalid = await zipBytes(z); await assert.rejects(() => validateAnimatedPptx(input, invalid), /顺序/);
  const valid = await JSZip.loadAsync(result.buffer), propsFile = 'ppt/presProps.xml', props = parseXml(await valid.file(propsFile).async('string'));
  descendants(props, NS.p, 'showPr')[0].setAttribute('showAnimation', '0'); valid.file(propsFile, serialize(props));
  const disabled = await zipBytes(valid); await assert.rejects(() => validateAnimatedPptx(input, disabled), /动画.*禁用|禁用.*动画/);
});
