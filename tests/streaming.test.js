import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { planDeck } from '../src/outline.js';
import { createApp } from '../src/app.js';

const deck = { title: '中文流式验收', slides: [{ title: '主题', layout: 'cover', bullets: [] }, { title: '重点', layout: 'content', bullets: ['保留原始材料中的事实'] }] };
const raw = JSON.stringify(deck);
const config = { baseUrl: 'https://fixture.invalid/v1', model: 'current-codex-model', wireApi: 'responses', apiKey: 'private-test-key', reasoningEffort: 'high' };
const event = (type, data) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...data })}\r\n\r\n`;
function responseStream(wire) {
  const bytes = new TextEncoder().encode(wire);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
const complete = event('response.completed', { response: { status: 'completed' } });
test('Responses uses the current model and streams fragmented UTF-8 text before completion', async () => {
  const deltas = []; let request;
  const result = await planDeck('材料事实', { mode: 'ai', config, stream: true, onDelta: delta => deltas.push(delta), fetchImpl: async (url, options) => {
    request = { url, ...options, body: JSON.parse(options.body) };
    return responseStream(event('response.output_text.delta', { delta: raw.slice(0, 23) }) + event('response.output_text.delta', { delta: raw.slice(23) }) + complete);
  } });
  assert.equal(request.url, 'https://fixture.invalid/v1/responses');
  assert.equal(request.body.model, config.model);
  assert.equal(request.body.stream, true);
  assert.equal(request.body.reasoning.effort, 'high');
  assert.equal(request.body.store, false);
  // Codex-compatible relays can reject text.format even when plain Responses succeeds.
  assert.equal(request.body.text, undefined);
  assert.equal(request.headers.authorization, 'Bearer private-test-key');
  assert.match(JSON.stringify(request.body.input), /材料事实/);
  assert.equal(deltas.length, 2);
  assert.equal(deltas.join(''), raw);
  assert.equal(result.deck.title, deck.title);
});
test('Chat Completions remains available with real incremental deltas', async () => {
  const deltas = [];
  const result = await planDeck('材料', { mode: 'ai', config: { ...config, wireApi: 'chat_completions' }, stream: true, onDelta: delta => deltas.push(delta), fetchImpl: async (url, options) => {
    assert.match(url, /chat\/completions$/); assert.equal(JSON.parse(options.body).stream, true);
    return responseStream(`data: ${JSON.stringify({ choices: [{ delta: { content: raw }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } });
  assert.equal(result.origin, 'ai'); assert.equal(deltas.join(''), raw);
});
test('a valid-looking JSON followed by EOF without a completion event is rejected', async () => {
  await assert.rejects(() => planDeck('材料', { mode: 'ai', config, stream: true, onDelta() {}, fetchImpl: async () => responseStream(event('response.output_text.delta', { delta: raw })) }), /中断|完成/);
});
test('upstream failed and incomplete events do not leak provider secrets or silently export', async () => {
  for (const type of ['response.failed', 'response.incomplete', 'error']) {
    await assert.rejects(() => planDeck('材料', { mode: 'ai', config, stream: true, fetchImpl: async () => responseStream(event('response.output_text.delta', { delta: raw }) + event(type, { error: { message: config.apiKey } })) }), error => /失败|截断|完成/.test(error.message) && !error.message.includes(config.apiKey));
  }
});
test('Chat length truncation and non-SSE responses cannot masquerade as completed streams', async () => {
  await assert.rejects(() => planDeck('材料', { mode: 'ai', config: { ...config, wireApi: 'chat_completions' }, stream: true, fetchImpl: async () => responseStream(`data: ${JSON.stringify({ choices: [{ delta: { content: raw }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`) }), /截断/);
  await assert.rejects(() => planDeck('材料', { mode: 'ai', config, stream: true, fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }) }), /流式/);
});
test('the local streaming API forwards a delta before the provider is allowed to finish', async t => {
  let finishProvider;
  const providerFinished = new Promise(resolve => { finishProvider = resolve; });
  const provider = createServer(async (req, res) => {
    for await (const chunk of req) { /* consume request */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event('response.output_text.delta', { delta: raw.slice(0, 25) }));
    await providerFinished;
    res.end(event('response.output_text.delta', { delta: raw.slice(25) }) + complete);
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const app = createApp({ ...config, baseUrl: `http://127.0.0.1:${provider.address().port}/v1` }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => { finishProvider(); app.closeAllConnections(); provider.closeAllConnections(); app.close(); provider.close(); });
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/plan/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '来源材料', mode: 'ai' }) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(); let prefix = '';
  const deadline = setTimeout(finishProvider, 4000);
  try {
    while (!prefix.includes('event: delta')) {
      const value = await reader.read(); assert.equal(value.done, false); prefix += new TextDecoder().decode(value.value);
    }
    assert.ok(!prefix.includes('event: completed'));
    assert.match(prefix, /中文|title/);
  } finally { clearTimeout(deadline); finishProvider(); }
  let remaining = ''; for (;;) { const part = await reader.read(); if (part.done) break; remaining += new TextDecoder().decode(part.value); }
  assert.match(remaining, /event: completed/); assert.match(remaining, /中文流式验收/);
});
test('the browser stream reader handles split events and requires validated completion', async () => {
  const { consumePlanStream } = await import('../public/stream.js');
  const deltas = [];
  const result = await consumePlanStream(responseStream(`event: delta\ndata: ${JSON.stringify({ text: '中文片段' })}\n\nevent: completed\ndata: ${JSON.stringify({ origin: 'ai', deck })}\n\n`), text => deltas.push(text));
  assert.deepEqual(deltas, ['中文片段']); assert.equal(result.deck.title, deck.title);
  await assert.rejects(() => consumePlanStream(responseStream('event: delta\ndata: {"text":"unfinished"}\n\n')), /中断|完成/);
  await assert.rejects(() => consumePlanStream(responseStream('event: error\ndata: {"error":"模型请求失败"}\n\n')), /模型请求失败/);
});
test('incremental slide previews expose complete slides without parsing unfinished JSON strings', async () => {
  const { completedSlides } = await import('../public/stream.js');
  const tricky = { title: '字符串包含 } 和 \\"', layout: 'content', bullets: ['引号 "、方括号 ]、中文与 emoji 😀', '文字中的 "slides": [ 不应成为结构'], notes: '保留换行\n和反斜线\\' };
  const text = JSON.stringify({ title: 'deck', slides: [tricky, { title: '下一页', bullets: ['未完成'] }] });
  const firstEnd = text.indexOf('},{') + 1;
  assert.equal(completedSlides(text.slice(0, firstEnd - 2)).length, 0);
  assert.deepEqual(completedSlides(text.slice(0, firstEnd + 12)), [tricky]);
  assert.equal(completedSlides(text).length, 2);
  assert.deepEqual(completedSlides('{"title":"no slides yet"'), []);
});
test('disconnecting the browser cancels the live upstream request', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const provider = createServer(async (req, res) => {
    for await (const chunk of req) { /* consume request */ }
    res.on('close', upstreamClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(event('response.output_text.delta', { delta: '{"title":' }));
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const app = createApp({ ...config, baseUrl: `http://127.0.0.1:${provider.address().port}/v1` }).listen(0, '127.0.0.1');
  await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); provider.closeAllConnections(); app.close(); provider.close(); });
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${app.address().port}/api/plan/stream`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '材料', mode: 'ai' }) });
  const reader = response.body.getReader(); let chunks = '';
  while (!chunks.includes('event: delta')) chunks += new TextDecoder().decode((await reader.read()).value);
  controller.abort();
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('上游未取消')), 2000); timer.unref(); })]);
});
