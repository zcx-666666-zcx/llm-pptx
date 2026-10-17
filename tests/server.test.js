import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import JSZip from 'jszip';
import { createApp } from '../src/app.js';

async function serve(t, config = {}) {
  const server = createApp(config).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
function form(buffer, filename, settings) {
  const data = new FormData(); data.set('file', new Blob([buffer]), filename);
  if (settings) data.set('settings', JSON.stringify(settings));
  return data;
}
test('the HTTP workflow exports static, accepts an edited upload and downloads animated PPTX', async t => {
  const base = await serve(t);
  const jsonPost = (route, body) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(base)).status, 200);
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.aiConfigured, false);
  assert.ok(!JSON.stringify(config).includes('apiKey'));
  const outline = await (await jsonPost('/api/plan', { text: '# 汇报\n## 进展\n已完成生成引擎。\n正在增加动画。', mode: 'source' })).json();
  assert.equal(outline.origin, 'source');
  const exported = await jsonPost('/api/export', { deck: outline.deck, theme: 'studio' });
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  const source = Buffer.from(await exported.arrayBuffer());
  const zip = await JSZip.loadAsync(source);
  zip.file('ppt/slides/slide2.xml', (await zip.file('ppt/slides/slide2.xml').async('string')).replace('已完成生成引擎。', '我的人工修改。'));
  const edited = await zip.generateAsync({ type: 'nodebuffer' });
  const inspection = await fetch(base + '/api/inspect', { method: 'POST', body: form(edited, 'edited.pptx') });
  const info = await inspection.json();
  assert.ok(info.slides[1].shapes.some(s => s.text.includes('我的人工修改')));
  const converted = await fetch(base + '/api/animate', { method: 'POST', body: form(edited, 'edited.pptx', { effect: 'fade', trigger: 'auto' }) });
  assert.equal(converted.status, 200);
  const result = await JSZip.loadAsync(await converted.arrayBuffer());
  assert.match(await result.file('ppt/slides/slide2.xml').async('string'), /我的人工修改/);
  assert.match(await result.file('ppt/slides/slide2.xml').async('string'), /<p:timing/);
});
test('document upload works through the public API', async t => {
  const base = await serve(t);
  const res = await fetch(base + '/api/documents', { method: 'POST', body: form(Buffer.from('中文材料'), '材料.txt') });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, '中文材料');
});
test('invalid upload, settings, input and cross-origin writes produce safe errors', async t => {
  const base = await serve(t);
  const request = (route, body, extra = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await request('/api/plan', { text: '', mode: 'source' })).status, 400);
  assert.equal((await request('/api/plan', { text: 'x', mode: 'ai' })).status, 400);
  assert.equal((await request('/api/plan', { text: 'x' }, { origin: 'https://evil.example' })).status, 403);
  const bad = await fetch(base + '/api/inspect', { method: 'POST', body: form(Buffer.from('bad'), 'fake.pptx') });
  assert.equal(bad.status, 400);
  const malformed = await request('/api/export', { deck: { title: '<script>alert(1)</script>', slides: [] } });
  assert.equal(malformed.status, 400);
  assert.ok(!(await malformed.text()).includes('node_modules'));
});
test('Chinese uploaded filenames remain readable in animated downloads', async t => {
  const base = await serve(t);
  const { generatePptx } = await import('../src/presentation.js');
  const input = await generatePptx({ title: '演示', slides: [{ title: '标题', bullets: ['正文'] }] });
  const response = await fetch(base + '/api/animate', { method: 'POST', body: form(input, '人工调整.pptx', {}) });
  assert.equal(response.status, 200);
  assert.match(decodeURIComponent(response.headers.get('content-disposition')), /人工调整-动态/);
});
test('AI planning reaches a configured provider through a real HTTP request', async t => {
  const { createServer } = await import('node:http');
  let received;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received = { path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: '来自测试模型', slides: [{ title: '模型整理', bullets: ['基于输入材料的重点'] }] }) } }] }));
  }).listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => provider.close(resolve)));
  await once(provider, 'listening');
  const base = await serve(t, { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'fixture-model', apiKey: 'fixture-key' });
  const response = await fetch(base + '/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '用户材料', mode: 'ai' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).origin, 'ai');
  assert.equal(received.path, '/v1/chat/completions');
  assert.equal(received.auth, 'Bearer fixture-key');
  assert.equal(received.body.model, 'fixture-model');
  assert.match(received.body.messages[1].content, /用户材料/);
  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.aiConfigured, true);
  assert.ok(!JSON.stringify(config).includes('fixture-key'));
});
