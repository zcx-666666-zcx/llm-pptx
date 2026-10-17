import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { generatePptx } from '../src/presentation.js';
import { planAnimations, refineAnimationPage } from '../src/animation.js';
const deck = { title: '实施方案', slides: [{ title: '实施方案', layout: 'cover', bullets: [] }, { title: '实施流程', layout: 'process', bullets: ['需求核对', '方案实施', '交付检查'] }] };
async function serve(t, config = {}) { const server = createApp(config).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); }); return `http://127.0.0.1:${server.address().port}`; }
const form = (buffer, value, name = 'plan') => { const data = new FormData(); data.set('file', new Blob([buffer]), '人工调整.pptx'); if (value) data.set(name, JSON.stringify(value)); return data; };
test('HTTP native workflow plans and exports a presenter-controlled PPTX', async t => {
  const base = await serve(t), input = await generatePptx(deck);
  const planned = await fetch(base + '/api/animation-plan', { method: 'POST', body: form(input) });
  assert.equal(planned.status, 200); const plan = await planned.json();
  assert.equal(plan.slides.length, 2); assert.equal(plan.slides[1].steps[1].trigger, 'click');
  const response = await fetch(base + '/api/animate-native', { method: 'POST', body: form(input, plan) });
  assert.equal(response.status, 200); assert.match(decodeURIComponent(response.headers.get('content-disposition')), /人工调整-动态/);
  const report = JSON.parse(decodeURIComponent(response.headers.get('x-animation-report')));
  assert.equal(report.structuralValidation.passed, true); assert.equal(report.wpsPlaybackValidated, false);
  const tampered = structuredClone(plan); tampered.slides[1].steps[0].targets = ['999'];
  const invalid = await fetch(base + '/api/animate-native', { method: 'POST', body: form(input, tampered) }); assert.equal(invalid.status, 400);
});
test('homepage offers optional counts and native steps instead of video/keyframes', async t => {
  const base = await serve(t), html = await (await fetch(base)).text();
  assert.doesNotMatch(html, /<video|cinema-build|每页时长|影片版|Morph PPTX/);
  assert.match(html, /步骤|讲解/); assert.match(html, /留空|自动决定/);
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /initCinema|\/api\/cinematic/);
});
test('AI refinement sends only current-page object summaries and streams a validated patch', async t => {
  const input = await generatePptx(deck), initial = await planAnimations(input), page = initial.slides[1];
  let received;
  const provider = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c; received = JSON.parse(body);
    const text = JSON.stringify({ steps: page.steps.map(s => ({ ...s, duration: 700 })) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n`);
  }).listen(0, '127.0.0.1'); await once(provider, 'listening'); t.after(() => { provider.closeAllConnections(); provider.close(); });
  const base = await serve(t, { baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, model: 'current-model', wireApi: 'responses' });
  const response = await fetch(base + '/api/animation-plan/stream', { method: 'POST', body: form(input, { number: 2, page }, 'settings') });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const wire = await response.text(); assert.match(wire, /event: delta/); assert.match(wire, /event: completed/);
  const summary = JSON.parse(received.input[0].content);
  assert.equal(summary.title, '实施流程'); assert.ok(summary.objects.length); assert.equal(summary.slides, undefined); assert.equal(summary.notes, undefined);
  assert.ok(!JSON.stringify(received).includes('<p:')); assert.equal(received.stream, true);
});
test('AI refinement rejects invalid object IDs without overwriting a page', async () => {
  const input = await generatePptx(deck), deltas = [];
  await assert.rejects(() => refineAnimationPage(input, { number: 2, config: { baseUrl: 'http://fixture/v1', model: 'x' }, onDelta: d => deltas.push(d), fetchImpl: async () => new Response('data: {"choices":[{"delta":{"content":"{\\"steps\\":[{\\"id\\":\\"x\\",\\"label\\":\\"wrong\\",\\"targets\\":[\\"999\\"],\\"trigger\\":\\"click\\",\\"effect\\":\\"fade\\",\\"duration\\":600}]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) }), /对象/);
});
