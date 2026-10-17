import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { extractDocument } from '../src/documents.js';
import { structureText, validateDeck, planDeck } from '../src/outline.js';
import { generatePptx } from '../src/presentation.js';
import { inspectPptx, animatePptx } from '../src/animation.js';

const deck = { title: '项目进展', slides: [
  { title: '项目进展', layout: 'cover', subtitle: '十月汇报', bullets: [] },
  { title: '可编辑的内容', layout: 'content', bullets: ['保留中文与数字 42', '第二个重点'] },
] };
const NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const parse = xml => new DOMParser().parseFromString(xml, 'application/xml');
const serialize = el => new XMLSerializer().serializeToString(el);
const byTag = (doc, name) => [...doc.getElementsByTagNameNS(NS, name)];

// This fixture models a user edit made after download, including a reordered slide,
// a new text shape, an image payload, notes and an unsupported custom part.
async function editedFixture() {
  const zip = await JSZip.loadAsync(await generatePptx(deck));
  const path = 'ppt/slides/slide2.xml';
  let xml = await zip.file(path).async('string');
  xml = xml.replace('</p:spTree>', '<p:sp><p:nvSpPr><p:cNvPr id="87" name="人工追加"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="4500000"/><a:ext cx="5000000" cy="600000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>人工调整后的文字 &amp; 数字 2026</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>');
  zip.file(path, xml);
  zip.file('customXml/item1.xml', '<custom>must survive verbatim</custom>');
  zip.file('ppt/media/preserved.bin', Buffer.from([0, 255, 37, 64]));
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('UTF-8 text and Markdown are read without losing Chinese', async () => {
  assert.equal(await extractDocument(Buffer.from('# 标题\n正文'), '报告.md'), '# 标题\n正文');
});
test('DOCX paragraphs retain ordering', async () => {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  z.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>');
  assert.match(await extractDocument(await z.generateAsync({ type: 'nodebuffer' }), '报告.docx'), /第一段\s+第二段/);
});
test('unsupported document types fail clearly', async () => {
  await assert.rejects(() => extractDocument(Buffer.from('x'), 'report.exe'), /支持/);
});
test('blank documents are rejected', async () => {
  await assert.rejects(() => extractDocument(Buffer.from('   '), 'empty.txt'), /内容|文字/);
});
test('Markdown headings become slides, long input is paginated without silent loss', () => {
  const text = '# 项目\n## 方案\n' + Array.from({ length: 19 }, (_, i) => `- 重点${i}`).join('\n');
  const result = structureText(text, { title: '项目' });
  assert.equal(result.slides[0].layout, 'cover');
  assert.ok(result.slides.length >= 5);
  assert.match(JSON.stringify(result), /重点18/);
});
test('oversized slide text fails validation instead of clipping silently', () => {
  assert.throws(() => validateDeck({ ...deck, slides: [{ title: '标题', bullets: ['字'.repeat(500)] }] }), /长|字符|too_big/);
});
test('explicit source mode requires no model and reports its origin', async () => {
  const result = await planDeck('这是原始材料。\n第一条内容。', { mode: 'source' });
  assert.equal(result.origin, 'source');
  assert.match(JSON.stringify(result.deck), /第一条内容/);
});
test('AI mode fails clearly when no model is configured', async () => {
  await assert.rejects(() => planDeck('请做汇报', { mode: 'ai', config: {} }), /配置/);
});
test('AI endpoint response is validated and source is identified', async () => {
  let received;
  const result = await planDeck('输入材料', { mode: 'ai', config: { baseUrl: 'http://localhost:9999/v1', model: 'test-model', apiKey: 'test' }, fetchImpl: async (url, options) => {
    received = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(deck) } }] }));
  } });
  assert.equal(received.url, 'http://localhost:9999/v1/chat/completions');
  assert.equal(received.body.model, 'test-model');
  assert.equal(result.origin, 'ai');
  assert.equal(result.deck.slides.length, 2);
});
test('AI failures cannot be silently replaced by local generation', async () => {
  await assert.rejects(() => planDeck('输入', { mode: 'ai', config: { baseUrl: 'http://localhost/v1', model: 'x' }, fetchImpl: async () => new Response('private error', { status: 401 }) }), /401/);
});
test('static PPTX contains native editable text and no animation', async () => {
  const bytes = await generatePptx(deck);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('ppt/slides/slide2.xml').async('string');
  assert.match(xml, /保留中文与数字 42/);
  assert.doesNotMatch(xml, /<p:timing/);
  assert.ok(byTag(parse(xml), 'sp').length >= 3);
});
test('inspection finds manual additions and excludes generated decoration', async () => {
  const info = await inspectPptx(await editedFixture());
  assert.equal(info.slides.length, 2);
  assert.ok(info.slides[1].shapes.some(s => s.id === '87' && s.text.includes('人工调整后的文字')));
  assert.ok(info.slides.every(s => s.shapes.every(o => !o.name.startsWith('llmpptx:decor:'))));
});
test('animation only changes slide XML and preserves user content', async () => {
  const original = await editedFixture();
  const output = await animatePptx(original, { effect: 'fade', trigger: 'click', duration: 500 });
  const before = await JSZip.loadAsync(original);
  const after = await JSZip.loadAsync(output.buffer);
  assert.deepEqual(Object.keys(before.files).sort(), Object.keys(after.files).sort());
  for (const path of Object.keys(before.files).filter(p => !before.files[p].dir)) {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(path)) {
      const a = parse(await before.file(path).async('string'));
      const b = parse(await after.file(path).async('string'));
      assert.equal(serialize(byTag(a, 'cSld')[0]), serialize(byTag(b, 'cSld')[0]), path);
      assert.equal(byTag(b, 'timing').length, 1);
      assert.equal(byTag(b, 'transition').length, 1);
      const ids = byTag(b, 'cTn').map(n => n.getAttribute('id'));
      assert.equal(ids.length, new Set(ids).size);
      const targets = byTag(b, 'spTgt').map(n => n.getAttribute('spid'));
      assert.ok(targets.every(id => byTag(b, 'cNvPr').some(n => n.getAttribute('id') === id)));
      assert.match(await after.file(path).async('string'), /mainSeq/);
    } else {
      assert.deepEqual(await before.file(path).async('nodebuffer'), await after.file(path).async('nodebuffer'), path);
    }
  }
  assert.match(await after.file('ppt/slides/slide2.xml').async('string'), /spid="87"/);
  assert.equal(output.report.animatedSlides, 2);
});
test('a repeated conversion preserves existing animations by default', async () => {
  const first = await animatePptx(await editedFixture(), {});
  const second = await animatePptx(first.buffer, {});
  const one = await JSZip.loadAsync(first.buffer), two = await JSZip.loadAsync(second.buffer);
  assert.equal(await one.file('ppt/slides/slide2.xml').async('string'), await two.file('ppt/slides/slide2.xml').async('string'));
  assert.equal(second.report.skippedSlides, 2);
});
test('animation selection is applied to selected user objects only', async () => {
  const output = await animatePptx(await editedFixture(), { selection: { '2': ['87'] }, trigger: 'auto' });
  const z = await JSZip.loadAsync(output.buffer);
  assert.equal(byTag(parse(await z.file('ppt/slides/slide1.xml').async('string')), 'timing').length, 0);
  const xml = await z.file('ppt/slides/slide2.xml').async('string');
  assert.deepEqual([...new Set(byTag(parse(xml), 'spTgt').map(n => n.getAttribute('spid')))], ['87']);
});
test('invalid animation selections fail instead of producing a misleading file', async () => {
  await assert.rejects(async () => animatePptx(await editedFixture(), { selection: { '2': ['999'] } }), /不存在|对象/);
});
test('transition can be disabled, effects and durations are bounded', async () => {
  const out = await animatePptx(await editedFixture(), { effect: 'appear', transition: 'none' });
  const z = await JSZip.loadAsync(out.buffer);
  assert.equal(byTag(parse(await z.file('ppt/slides/slide1.xml').async('string')), 'transition').length, 0);
  await assert.rejects(async () => animatePptx(await editedFixture(), { effect: 'invalid' }), /effect|效果|Invalid/);
  await assert.rejects(async () => animatePptx(await editedFixture(), { duration: -100 }), /duration|时长|small/);
});
test('invalid uploads and XML entity declarations are rejected', async () => {
  await assert.rejects(() => inspectPptx(Buffer.from('not a pptx')), /PPTX|ZIP/);
  const z = await JSZip.loadAsync(await editedFixture());
  z.file('ppt/slides/slide1.xml', '<!DOCTYPE x [<!ENTITY x "bad">]><p:sld xmlns:p="'+NS+'"/>');
  await assert.rejects(async () => inspectPptx(await z.generateAsync({ type: 'nodebuffer' })), /XML|声明/);
});

test('slide inspection follows presentation relationships after a user reorders pages', async () => {
  const z = await JSZip.loadAsync(await editedFixture());
  const xml = await z.file('ppt/presentation.xml').async('string');
  const ids = xml.match(/<p:sldId\b[^>]*\/>/g);
  assert.equal(ids.length, 2);
  z.file('ppt/presentation.xml', xml.replace(ids[0], '__FIRST__').replace(ids[1], ids[0]).replace('__FIRST__', ids[1]));
  const info = await inspectPptx(await z.generateAsync({ type: 'nodebuffer' }));
  assert.ok(info.slides[0].shapes.some(s => s.id === '87'));
});
test('image, native table and notes survive animation conversion', async () => {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
  const slide = pptx.addSlide();
  slide.addText('图文示例', { x: 1, y: 1, w: 5, h: 1 });
  slide.addImage({ data: 'image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', x: 1, y: 3, w: 1, h: 1 });
  slide.addTable([['类别', '进展'], ['内容', '人工调整']], { x: 3, y: 3, w: 6, h: 2 });
  slide.addNotes('请保留这段人工讲稿');
  // PptxGenJS 4.0.1's table numbering restarts at 2, colliding with
  // the earlier text shape. Model a valid externally saved deck explicitly.
  const fixture = await JSZip.loadAsync(await pptx.write({ outputType: 'nodebuffer' }));
  fixture.file('ppt/slides/slide1.xml', (await fixture.file('ppt/slides/slide1.xml').async('string')).replace('<p:cNvPr id="2" name="Table 0"', '<p:cNvPr id="77" name="Table 0"'));
  const input = await fixture.generateAsync({ type: 'nodebuffer' });
  const info = await inspectPptx(input);
  assert.ok(info.slides[0].shapes.some(s => s.type === 'pic'));
  assert.ok(info.slides[0].shapes.some(s => s.type === 'graphicFrame'));
  const output = await animatePptx(input);
  const before = await JSZip.loadAsync(input), after = await JSZip.loadAsync(output.buffer);
  for (const name of Object.keys(before.files).filter(n => !before.files[n].dir && !n.startsWith('ppt/slides/slide'))) {
    assert.deepEqual(await before.file(name).async('nodebuffer'), await after.file(name).async('nodebuffer'), name);
  }
});
test('invalid or duplicate native shape IDs cannot enter timing XML', async () => {
  const zip = await JSZip.loadAsync(await editedFixture());
  const xml = await zip.file('ppt/slides/slide2.xml').async('string');
  zip.file('ppt/slides/slide2.xml', xml.replace('id="87"', 'id="invalid"'));
  await assert.rejects(async () => inspectPptx(await zip.generateAsync({ type: 'nodebuffer' })), /编号|ID/);
});
test('PDF source extraction does not add synthetic page-number text', async () => {
  // A deliberately small, valid text PDF. Offsets and xref are generated from
  // bytes rather than a malformed hand-written PDF that the parser might repair.
  const stream = 'BT /F1 20 Tf 40 150 Td (Source PDF material) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let data = '%PDF-1.4\n', offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10,'0') + ' 00000 n \n').join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF`;
  const text = await extractDocument(Buffer.from(data), 'source.pdf');
  assert.equal(text.trim(), 'Source PDF material');
});
test('duplicate native IDs are rejected before targeting objects', async () => {
  const zip = await JSZip.loadAsync(await editedFixture());
  const xml = await zip.file('ppt/slides/slide2.xml').async('string');
  const existingId = /<p:sp>.*?<p:cNvPr id="(\d+)"/s.exec(xml)[1];
  zip.file('ppt/slides/slide2.xml', xml.replace('id="87"', `id="${existingId}"`));
  await assert.rejects(async () => inspectPptx(await zip.generateAsync({ type: 'nodebuffer' })), /重复|编号|ID/);
});
test('overlong source headings are rejected rather than silently truncated', () => {
  assert.throws(() => structureText('# ' + '标题'.repeat(40) + '\n正文'), /标题|长/);
  assert.throws(() => structureText('# 演示\n## ' + '小标题'.repeat(30) + '\n正文'), /标题|长/);
});

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
function alternateXml(xml, fallback = xml) {
  return `<mc:AlternateContent xmlns:mc="${MC}" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"><mc:Choice Requires="p14">${xml}</mc:Choice><mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`;
}
test('compatibility-wrapped animations and transitions are preserved by default and replace cleanly', async () => {
  const first = await animatePptx(await editedFixture());
  const z = await JSZip.loadAsync(first.buffer);
  let xml = await z.file('ppt/slides/slide2.xml').async('string');
  xml = xml.replace(/<p:timing\b[\s\S]*?<\/p:timing>/, value => alternateXml(value));
  xml = xml.replace(/<p:transition\b[\s\S]*?<\/p:transition>/, value => alternateXml(value));
  z.file('ppt/slides/slide2.xml', xml);
  const source = await z.generateAsync({ type: 'nodebuffer' });
  const info = await inspectPptx(source);
  assert.equal(info.slides[1].hasAnimation, true);
  assert.equal(info.slides[1].hasTransition, true);
  const kept = await JSZip.loadAsync((await animatePptx(source)).buffer);
  assert.equal(await kept.file('ppt/slides/slide2.xml').async('string'), xml);
  const replaced = await JSZip.loadAsync((await animatePptx(source, { replaceExisting: true })).buffer);
  const doc = parse(await replaced.file('ppt/slides/slide2.xml').async('string'));
  assert.equal(byTag(doc, 'timing').length, 1);
  assert.equal(byTag(doc, 'transition').length, 2); // Mutually exclusive Choice and Fallback; no new duplicate.
});
test('mutually exclusive object representations sharing an ID are inspectable and preserved', async () => {
  const z = await JSZip.loadAsync(await editedFixture());
  let xml = await z.file('ppt/slides/slide2.xml').async('string');
  xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/, value => alternateXml(value));
  z.file('ppt/slides/slide2.xml', xml);
  const input = await z.generateAsync({ type: 'nodebuffer' });
  const info = await inspectPptx(input);
  assert.equal(info.slides[1].shapes[0].text, '可编辑的内容');
  assert.equal(info.slides[1].shapes.filter(s => s.text === '可编辑的内容').length, 1);
  const output = await JSZip.loadAsync((await animatePptx(input)).buffer);
  const after = parse(await output.file('ppt/slides/slide2.xml').async('string'));
  assert.equal(serialize(byTag(after, 'cSld')[0]), serialize(byTag(parse(xml), 'cSld')[0]));
});
test('different object IDs across compatibility branches fail explicitly rather than target the wrong branch', async () => {
  const z = await JSZip.loadAsync(await editedFixture());
  let xml = await z.file('ppt/slides/slide2.xml').async('string');
  xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/, value => alternateXml(value, value.replace(/<p:cNvPr id="\d+"/, '<p:cNvPr id="1234"')));
  z.file('ppt/slides/slide2.xml', xml);
  await assert.rejects(async () => inspectPptx(await z.generateAsync({ type: 'nodebuffer' })), /兼容性分支/);
});
test('multiline body has enough allocated vertical space and never overlaps the next body', async () => {
  const input = { title: '演示', slides: [{ title: '标题', layout: 'content', subtitle: '副标题', bullets: ['一\n二\n三\n四\n五\n六\n七\n八', '正常正文'] }] };
  const zip = await JSZip.loadAsync(await generatePptx(input));
  const doc = parse(await zip.file('ppt/slides/slide1.xml').async('string'));
  const bodies = byTag(doc, 'sp').filter(s => descendantsA(s, 't').some(t => t.textContent === '一') || descendantsA(s, 't').some(t => t.textContent === '正常正文'));
  function geometry(shape) { const xfrm = descendantsA(shape, 'xfrm')[0]; return { y: Number(descendantsA(xfrm, 'off')[0].getAttribute('y')), h: Number(descendantsA(xfrm, 'ext')[0].getAttribute('cy')) }; }
  const g1 = geometry(bodies[0]), g2 = geometry(bodies[1]);
  const size = Number(descendantsA(bodies[0], 'rPr')[0].getAttribute('sz')) / 100;
  assert.ok(g1.h / 12700 >= size * 8, 'eight lines must fit the allocated height');
  assert.ok(g1.y + g1.h <= g2.y, 'body boxes cannot overlap');
});
const descendantsA = (node, name) => [...node.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', name)];
test('excessively dense content fails with a layout error instead of clipped text', async () => {
  const input = { title: '演示', slides: [{ title: '标题', layout: 'content', subtitle: '副标题', bullets: Array.from({ length: 5 }, () => '字'.repeat(150)) }] };
  await assert.rejects(() => generatePptx(input), /容纳|拆分|过多/);
});
test('nested mutually exclusive object representations compare their effective IDs', async () => {
  for (const nestedFallback of [false, true]) {
    const z = await JSZip.loadAsync(await editedFixture());
    let xml = await z.file('ppt/slides/slide2.xml').async('string');
    xml = xml.replace(/<p:sp>[\s\S]*?<\/p:sp>/, value => nestedFallback ? alternateXml(value, alternateXml(value)) : alternateXml(alternateXml(value), value));
    z.file('ppt/slides/slide2.xml', xml);
    const info = await inspectPptx(await z.generateAsync({ type: 'nodebuffer' }));
    assert.equal(info.slides[1].shapes.filter(s => s.text === '可编辑的内容').length, 1);
  }
});
test('new transition and timing precede a root compatibility-wrapped extension list', async () => {
  const z = await JSZip.loadAsync(await editedFixture());
  let xml = await z.file('ppt/slides/slide2.xml').async('string');
  xml = xml.replace('</p:sld>', alternateXml('<p:extLst/>') + '</p:sld>');
  z.file('ppt/slides/slide2.xml', xml);
  const result = await animatePptx(await z.generateAsync({ type: 'nodebuffer' }));
  const out = await JSZip.loadAsync(result.buffer), doc = parse(await out.file('ppt/slides/slide2.xml').async('string'));
  const children = [...doc.documentElement.childNodes].filter(n => n.nodeType === 1);
  assert.ok(children.findIndex(n => n.localName === 'timing') < children.findIndex(n => n.localName === 'AlternateContent'));
  assert.ok(children.findIndex(n => n.localName === 'transition') < children.findIndex(n => n.localName === 'timing'));
});
