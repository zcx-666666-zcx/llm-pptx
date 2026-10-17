import { createApp } from './app.js';
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || '127.0.0.1';
const config = { baseUrl: process.env.LLM_BASE_URL || '', model: process.env.LLM_MODEL || '', apiKey: process.env.LLM_API_KEY || '', wireApi: process.env.LLM_WIRE_API || 'chat_completions', reasoningEffort: process.env.LLM_REASONING_EFFORT || '' };
const server = createApp(config).listen(port, host, () => console.log(`llm-pptx 已启动：http://${host}:${port}`));
server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
