import test from 'node:test';
import assert from 'node:assert/strict';
import { structureText } from '../src/outline.js';
import { generatePptx } from '../src/presentation.js';
import { animatePptx, inspectPptx } from '../src/animation.js';

test('consecutive and final section headings remain as editable slides', async () => {
  const result = structureText('# 工作汇报\n## 项目背景\n## 实施方案\n已有正文\n## 风险事项');
  assert.deepEqual(result.slides.map(s => s.title), ['工作汇报', '项目背景', '实施方案', '风险事项']);
  assert.deepEqual(result.slides[1].bullets, []);
  assert.deepEqual(result.slides[2].bullets, ['已有正文']);
  assert.deepEqual(result.slides[3].bullets, []);
  const staticFile = await generatePptx(result);
  const animated = await animatePptx(staticFile, { trigger: 'click' });
  assert.deepEqual((await inspectPptx(animated.buffer)).slides.map(s => s.title), result.slides.map(s => s.title));
  assert.equal(animated.report.animatedSlides, 4);
});

test('astral Unicode text is paginated within schema limits without losing code points', async () => {
  const source = '🧭𠮷🚀'.repeat(90);
  const result = structureText('# 字符保留\n' + source);
  const body = result.slides.flatMap(s => s.bullets);
  assert.equal(body.join(''), source);
  assert.ok(body.every(text => text.length <= 92));
  assert.ok(body.every(text => [...text].every(point => !/[\uD800-\uDFFF]/u.test(point))));
  const inventory = await inspectPptx(await generatePptx(result));
  const written = inventory.slides.flatMap(slide => slide.shapes.filter(s => s.name.startsWith('正文')).map(s => s.text)).join('');
  assert.equal(written, source);
});

test('a full section followed by a new heading produces no empty continuation page', () => {
  const result = structureText('# 汇报\n## 第一章\n- 一\n- 二\n- 三\n- 四\n## 第二章');
  assert.deepEqual(result.slides.map(s => s.title), ['汇报', '第一章', '第二章']);
  assert.deepEqual(result.slides[1].bullets, ['一', '二', '三', '四']);
});

test('a title-only document remains exactly one cover slide', () => {
  assert.deepEqual(structureText('# 唯一标题').slides, [{ title: '唯一标题', layout: 'cover', bullets: [] }]);
});
