import { readSse } from '../public/stream.js';
const requestFailed = () => new Error('模型请求失败或超时，请检查地址、网络和服务状态');
export async function requestModel(messages, { config, stream = false, onDelta = () => {}, signal, fetchImpl = fetch }) {
  const wireApi = config.wireApi || 'chat_completions';
  if (!['responses', 'chat_completions'].includes(wireApi)) throw new Error('模型接口类型必须为 responses 或 chat_completions');
  const responses = wireApi === 'responses';
  // Some Codex-compatible relays reject text.format; the prompt and deck schema enforce JSON instead.
  const body = responses ? {
    model: config.model, stream, store: false,
    instructions: messages[0].content, input: messages.slice(1),
    ...(config.reasoningEffort ? { reasoning: { effort: config.reasoningEffort } } : {}),
  } : { model: config.model, stream, temperature: 0.3, response_format: { type: 'json_object' }, messages };
  let response;
  const timeout = AbortSignal.timeout(180000);
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/${responses ? 'responses' : 'chat/completions'}`, {
      method: 'POST', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { 'content-type': 'application/json', accept: stream ? 'text/event-stream' : 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch { throw requestFailed(); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`模型请求失败（HTTP ${response.status}），请检查模型配置和额度`); }
  if (!stream) {
    try {
      const data = await response.json();
      if (responses && data.status && data.status !== 'completed') throw new Error();
      const text = responses ? outputText(data) : data.choices[0].message.content;
      if (typeof text !== 'string' || !text) throw new Error();
      return text;
    } catch { throw new Error('模型未返回有效 JSON，请调整模型或重试'); }
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel(); throw new Error('模型服务未返回流式输出，请检查接口类型和服务支持');
  }
  let text = '', completed = false;
  const append = async delta => {
    if (typeof delta !== 'string') throw new Error('模型流式输出格式错误');
    text += delta;
    if (text.length > 1024 * 1024) throw new Error('模型输出过长，请缩短材料或减少页数');
    if (delta) await onDelta(delta);
  };
  try {
    for await (const event of readSse(response.body)) {
      if (event.data === '[DONE]') {
        if (!responses) completed = true;
        break;
      }
      let data;
      try { data = JSON.parse(event.data); } catch { throw new Error('模型流式输出格式错误'); }
      const type = data.type || event.type;
      if (data.error || ['error', 'response.failed', 'response.incomplete'].includes(type)) throw new Error('模型生成失败或输出被截断，请检查服务后重试');
      if (responses) {
        if (type === 'response.output_text.delta') await append(data.delta);
        else if (type === 'response.refusal.delta') throw new Error('模型未能生成这份材料，请调整输入后重试');
        else if (type === 'response.completed') {
          if (data.response?.status && data.response.status !== 'completed') throw new Error('模型输出未完成，请重试');
          if (!text) await append(outputText(data.response || {}));
          completed = true; break;
        }
      } else {
        const choice = data.choices?.[0];
        if (choice?.finish_reason && choice.finish_reason !== 'stop') throw new Error('模型输出被截断或未正常完成，请减少页数后重试');
        if (choice?.delta?.refusal) throw new Error('模型未能生成这份材料，请调整输入后重试');
        if (choice?.delta?.content) await append(choice.delta.content);
      }
    }
  } catch (error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError' || error instanceof TypeError) throw requestFailed();
    throw error;
  }
  if (!completed) throw new Error('模型连接已中断，未收到完成确认，请重试');
  if (!text) throw new Error('模型未返回页面内容，请重试');
  return text;
}
function outputText(response) {
  return (response.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('');
}
