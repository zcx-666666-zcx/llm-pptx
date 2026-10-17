import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { extractDocument } from './documents.js';
import { planDeck } from './outline.js';
import { generatePptx } from './presentation.js';
import { inspectPptx, animatePptx, planAnimations, applyAnimationPlan, refineAnimationPage } from './animation.js';
import { createMotionJobs } from './motion-jobs.js';
import { cinematicCapabilities } from './cinematic.js';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 4, fieldSize: 2 * 1024 * 1024, parts: 6 } });
const requestSchema = z.object({ text: z.string().trim().min(1, '请输入文字或上传文档').max(100000), mode: z.enum(['source', 'ai']), title: z.string().max(80).optional(), slideCount: z.coerce.number().int().min(1).max(30).optional() });
function fileRequired(req) {
  if (!req.file) throw new Error('请选择要上传的文件');
  // Busboy decodes plain multipart filenames as latin1; browsers send UTF-8.
  // Preserve correctly decoded RFC 5987 names and legacy latin1 names.
  if ([...req.file.originalname].every(c => c.codePointAt(0) <= 255)) {
    try { req.file.originalname = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(req.file.originalname, 'latin1')); } catch {}
  }
  return req.file;
}
function pptxRequired(req) { const file = fileRequired(req); if (!file.originalname.toLowerCase().endsWith('.pptx')) throw new Error('请上传 .pptx 文件'); return file; }
function sendPptx(res, buffer, name) {
  const safe = name.replace(/[\x00-\x1f<>:"/\\|?*]/g, '').slice(0, 90) || 'presentation';
  res.set('content-type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.set('content-disposition', `attachment; filename="presentation.pptx"; filename*=UTF-8''${encodeURIComponent(safe)}.pptx`);
  res.send(buffer);
}
export function createApp(config = {}, { motionJobs = createMotionJobs() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('cache-control', 'no-store'); res.set('x-content-type-options', 'nosniff'); res.set('referrer-policy', 'no-referrer');
    res.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const origin = req.get('origin');
    if (req.method !== 'GET' && origin && origin !== `http://${req.get('host')}` && origin !== `https://${req.get('host')}`) return res.status(403).json({ error: '不允许来自其他站点的写入请求' });
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/config', (req, res) => res.json({ aiConfigured: !!(config.baseUrl && config.model), model: config.model || '', wireApi: config.wireApi || 'chat_completions', streaming: true, documentFormats: ['txt', 'md', 'docx', 'pdf'], version: '0.1.0' }));
  app.post('/api/documents', upload.single('file'), async (req, res) => {
    const file = fileRequired(req);
    res.json({ text: await extractDocument(file.buffer, file.originalname) });
  });
  app.post('/api/plan', async (req, res) => {
    const data = requestSchema.parse(req.body);
    res.json(await planDeck(data.text, { ...data, config }));
  });
  app.post('/api/plan/stream', async (req, res) => {
    const data = requestSchema.parse(req.body);
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    res.set({ 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no', 'cache-control': 'no-cache, no-transform' });
    res.flushHeaders();
    const send = (event, value) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); };
    send('status', { message: data.mode === 'ai' ? '已发送模型请求，正在生成页面…' : '正在按原文分页…' });
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
    try {
      const result = await planDeck(data.text, { ...data, config, stream: true, signal: controller.signal, onDelta: text => send('delta', { text }) });
      send('completed', result);
    } catch (error) {
      send('error', { error: publicError(error) });
    } finally {
      clearInterval(heartbeat); res.off('close', disconnect); res.end();
    }
  });
  app.post('/api/export', async (req, res) => {
    const theme = z.enum(['studio', 'ink', 'night']).default('studio').parse(req.body.theme);
    sendPptx(res, await generatePptx(req.body.deck, { theme }), req.body.deck?.title || '静态演示');
  });
  const demoDirectory = fileURLToPath(new URL('../artifacts/continuous-demo/', import.meta.url));
  app.get('/api/cinematic-demo/status', async (req, res) => {
    try { await fs.access(`${demoDirectory}/motion.mp4`); res.json({ available: true }); } catch { res.json({ available: false }); }
  });
  for (const [file, local] of [['video.mp4', 'motion.mp4'], ['poster.png', 'poster.png']]) {
    app.get(`/api/cinematic-demo/${file}`, (req, res) => res.sendFile(`${demoDirectory}/${local}`));
  }
  let capabilities;
  app.get('/api/cinematic/capabilities', async (req, res) => res.json(await (capabilities ||= cinematicCapabilities())));
  app.post('/api/cinematic', upload.single('file'), async (req, res) => {
    const file = pptxRequired(req);
    let settings;
    try { settings = req.body.settings ? JSON.parse(req.body.settings) : {}; } catch { throw new Error('动态演示设置格式错误'); }
    res.status(202).json(await motionJobs.create(file.buffer, settings));
  });
  app.get('/api/cinematic/:id', (req, res) => {
    const job = motionJobs.status(req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在或文件已过期，请重新生成' });
    res.json(job);
  });
  app.delete('/api/cinematic/:id', (req, res) => {
    const job = motionJobs.cancel(req.params.id);
    if (!job) return res.status(404).json({ error: '任务不存在或文件已过期' });
    res.json(job);
  });
  for (const [filename, kind, attachment, downloadName] of [['video.mp4', 'video', false, null], ['presentation.pptx', 'presentation', true, 'continuous-motion-video.pptx'], ['native-motion.pptx', 'native', true, 'continuous-motion-native-morph.pptx'], ['poster.png', 'poster', false, null], ['source.pptx', 'source', true, 'original-editable.pptx']]) {
    app.get(`/api/cinematic/:id/${filename}`, (req, res) => {
      const file = motionJobs.file(req.params.id, kind);
      if (attachment) return res.download(file, downloadName);
      res.sendFile(file);
    });
  }
  app.post('/api/animation-plan', upload.single('file'), async (req, res) => res.json(await planAnimations(pptxRequired(req).buffer)));
  app.post('/api/animate-native', upload.single('file'), async (req, res) => {
    const file = pptxRequired(req);
    let plan;
    try { plan = JSON.parse(req.body.plan); } catch { throw new Error('动画方案格式错误，请重新生成'); }
    const result = await applyAnimationPlan(file.buffer, plan);
    const { details, ...summary } = result.report;
    res.set('x-animation-report', encodeURIComponent(JSON.stringify(summary)));
    sendPptx(res, result.buffer, file.originalname.replace(/\.pptx$/i, '') + '-动态');
  });
  app.post('/api/animation-plan/stream', upload.single('file'), async (req, res) => {
    const file = pptxRequired(req);
    let settings;
    try { settings = JSON.parse(req.body.settings); } catch { throw new Error('动画请求格式错误'); }
    const number = z.number().int().min(1).max(200).parse(settings.number);
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    res.set({ 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no', 'cache-control': 'no-cache, no-transform' }); res.flushHeaders();
    const send = (event, value) => { if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`); };
    send('status', { message: `正在优化第 ${number} 页动画` });
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15000);
    try {
      const page = await refineAnimationPage(file.buffer, { number, page: settings.page, config, signal: controller.signal, onDelta: text => send('delta', { text }) });
      send('completed', { page });
    } catch (error) { send('error', { error: publicError(error) }); }
    finally { clearInterval(heartbeat); res.off('close', disconnect); res.end(); }
  });
  app.post('/api/inspect', upload.single('file'), async (req, res) => res.json(await inspectPptx(pptxRequired(req).buffer)));
  app.post('/api/animate', upload.single('file'), async (req, res) => {
    const file = pptxRequired(req);
    let settings;
    try { settings = req.body.settings ? JSON.parse(req.body.settings) : {}; }
    catch { throw new Error('动画设置格式错误'); }
    const result = await animatePptx(file.buffer, settings);
    res.set('x-animation-report', encodeURIComponent(JSON.stringify(result.report)));
    sendPptx(res, result.buffer, file.originalname.replace(/\.pptx$/i, '') + '-动态');
  });
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use((error, req, res, next) => {
    const message = publicError(error);
    res.status(400).json({ error: message });
  });
  return app;
}

function publicError(error) {
  if (error instanceof ZodError) return error.issues.map(i => `${i.path.join('.')}: ${i.message}`).slice(0, 3).join('；');
  if (error instanceof multer.MulterError) return error.code === 'LIMIT_FILE_SIZE' ? '文件大小不能超过 30 MB' : '上传内容超出限制';
  if (error instanceof SyntaxError && 'body' in error) return '请求 JSON 格式不正确';
  if (error.message && !/stack|node_modules|ENOENT|EACCES/.test(error.message)) return error.message;
  return '处理失败，请检查输入后重试';
}
