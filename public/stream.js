// Shared SSE decoding for provider responses and the browser's generation stream.
// TextDecoder retains partial UTF-8 code points between network chunks.
export async function* readSse(body) {
  if (!body) throw new Error('流式响应为空');
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', type = 'message', data = [], size = 0;
  function line(value) {
    if (value.endsWith('\r')) value = value.slice(0, -1);
    if (!value) {
      const result = data.length ? { type, data: data.join('\n') } : null;
      type = 'message'; data = []; size = 0; return result;
    }
    if (value.startsWith(':')) return null;
    const colon = value.indexOf(':'), field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') type = content;
    if (field === 'data') { data.push(content); size += content.length; }
    if (size > 1024 * 1024) throw new Error('流式响应事件过大');
    return null;
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const parsed = line(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (parsed) yield parsed;
      }
      if (buffer.length > 1024 * 1024) throw new Error('流式响应事件过大');
      if (done) break;
    }
    // Per SSE framing, an unterminated event at EOF is discarded.
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function consumePlanStream(response, onDelta = () => {}) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('服务未返回流式响应');
  for await (const event of readSse(response.body)) {
    const data = JSON.parse(event.data);
    if (event.type === 'delta') await onDelta(data.text);
    else if (event.type === 'error') throw new Error(data.error || '生成失败，请重试');
    else if (event.type === 'completed') {
      if (!data.deck?.slides?.length) throw new Error('服务返回的页面数据不完整');
      return data;
    }
  }
  throw new Error('生成连接已中断，未收到完成确认，请重试');
}
export function completedSlides(text) {
  const start = /"slides"\s*:\s*\[/.exec(text);
  if (!start) return [];
  const slides = [];
  let quoted = false, escaped = false, depth = 0, objectStart = -1;
  for (let i = start.index + start[0].length; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ']' && depth === 0) break;
    if (char === '{') { if (depth === 0) objectStart = i; depth++; }
    else if (char === '}' && depth > 0 && --depth === 0) {
      try {
        const slide = JSON.parse(text.slice(objectStart, i + 1));
        if (typeof slide.title === 'string' && (!slide.bullets || (Array.isArray(slide.bullets) && slide.bullets.every(item => typeof item === 'string')))) slides.push(slide);
      } catch { /* A malformed partial slide never becomes an exportable draft. */ }
    }
  }
  return slides;
}
