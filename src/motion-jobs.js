import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { renderCinematic, cinematicSettings } from './cinematic.js';
import { inspectPptx } from './animation.js';

export function createMotionJobs({ root = os.tmpdir(), ttl = 60 * 60 * 1000, renderer = renderCinematic } = {}) {
  const jobs = new Map();
  const snapshot = job => job ? { id: job.id, state: job.state, phase: job.phase, progress: job.progress, message: job.message, error: job.error, report: job.result?.report, expiresAt: job.expiresAt } : null;
  const expire = job => {
    job.expiresAt = Date.now() + ttl;
    const timer = setTimeout(() => { jobs.delete(job.id); fs.rm(job.directory, { recursive: true, force: true }).catch(() => {}); }, ttl);
    timer.unref();
  };
  return {
    async create(buffer, options = {}) {
      if ([...jobs.values()].some(job => ['queued', 'running'].includes(job.state))) throw new Error('已有连续演示正在生成，请等待完成或先停止当前任务');
      const settings = cinematicSettings.parse(options);
      await inspectPptx(buffer);
      // Recheck after asynchronous validation to prevent simultaneous uploads exceeding one renderer.
      if ([...jobs.values()].some(job => ['queued', 'running'].includes(job.state))) throw new Error('已有连续演示正在生成，请等待完成或先停止当前任务');
      const id = randomUUID();
      const job = { id, state: 'queued', phase: 'queued', progress: 0, message: '正在准备连续动态演示…', controller: new AbortController() };
      jobs.set(id, job);
      try { await fs.mkdir(root, { recursive: true }); job.directory = await fs.mkdtemp(path.join(root, 'llm-pptx-motion-')); }
      catch { jobs.delete(id); throw new Error('无法创建本地渲染目录，请检查磁盘空间'); }
      setImmediate(async () => {
        try {
          if (job.controller.signal.aborted) return;
          job.state = 'running';
          job.result = await renderer(buffer, settings, { directory: job.directory, signal: job.controller.signal, onProgress: value => { if (!job.controller.signal.aborted) Object.assign(job, value); } });
          if (job.controller.signal.aborted) return;
          job.state = 'completed'; job.phase = 'completed'; job.progress = 100; job.message = '连续动态演示已生成，可以播放和下载。';
        } catch (error) {
          if (!job.controller.signal.aborted) { job.state = 'failed'; job.error = /ENOENT|EACCES|node_modules/.test(error.message) ? '渲染环境不可用，请检查依赖与磁盘空间' : error.message; job.message = '生成失败，请检查输入后重试'; }
        } finally {
          if (job.controller.signal.aborted) { job.state = 'cancelled'; job.message = '已停止生成'; await fs.rm(job.directory, { recursive: true, force: true }).catch(() => {}); }
          expire(job);
        }
      });
      return snapshot(job);
    },
    status(id) { return snapshot(jobs.get(id)); },
    file(id, kind) {
      const job = jobs.get(id);
      if (!job || job.state !== 'completed') throw new Error('生成尚未完成或文件已过期，请重新生成');
      const mapping = { video: 'videoPath', presentation: 'pptxPath', native: 'nativePptxPath', poster: 'posterPath', source: 'sourcePath' };
      const file = job.result[mapping[kind]];
      if (!file) throw new Error('生成结果中没有此文件');
      return file;
    },
    cancel(id) {
      const job = jobs.get(id);
      if (!job) return null;
      if (['queued', 'running'].includes(job.state)) { job.controller.abort(); job.state = 'cancelled'; job.message = '已停止生成'; }
      return snapshot(job);
    },
  };
}
