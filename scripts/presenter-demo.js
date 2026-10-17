import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { generatePptx } from '../src/presentation.js';
import { planAnimations, applyAnimationPlan } from '../src/animation.js';
export const deck = { title: '项目实施方案', slides: [
  { title: '项目实施方案', layout: 'cover', subtitle: '从需求核对到交付验收', bullets: [] },
  { title: '实施安排', layout: 'chapter', subtitle: '明确范围后逐步推进', bullets: [] },
  { title: '交付内容', layout: 'cards', bullets: ['可编辑的页面内容', '按讲解步骤展开的动画', '供两种演示软件检查的文件'] },
  { title: '两种推进方式', layout: 'comparison', bullets: ['自动展开：标题与基础内容进入页面后依次出现，随后停留', '分步讲解：每次点击展开一组内容，便于解释流程与对比'] },
  { title: '实施流程', layout: 'process', bullets: ['核对主题、材料和页数', '调整静态 PPTX 的文字与布局', '检查步骤后导出动态 PPTX'] },
  { title: '交付检查', layout: 'summary', bullets: ['文字与图形可以继续编辑', '原始页面数量和顺序保持一致', '演讲者控制每一步与翻页'] },
] };
export async function createPresenterDemo(root = fileURLToPath(new URL('../artifacts/', import.meta.url))) {
  await mkdir(root, { recursive: true }); const directory = await mkdtemp(join(resolve(root), 'presenter-'));
  const input = await generatePptx(deck), plan = await planAnimations(input), result = await applyAnimationPlan(input, plan);
  await writeFile(join(directory, 'static.pptx'), input); await writeFile(join(directory, 'animated.pptx'), result.buffer);
  await writeFile(join(directory, 'animation-plan.json'), JSON.stringify(plan, null, 2));
  const files = [{ path: 'static.pptx', buffer: input }, { path: 'animated.pptx', buffer: result.buffer }].map(({ path, buffer }) => ({ path, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }));
  await writeFile(join(directory, 'verification.json'), JSON.stringify({ generatedAt: new Date().toISOString(), screenshotsTaken: 0, visionUsed: false, aiProviderValidated: false, files, ...result.report }, null, 2));
  await writeFile(join(directory, 'PLAYBACK.md'), '# 原生动画放映检查\n\n共六页，未使用视频或增加关键帧页。\n\n- 第1、2、3、6页：进入后自动展开，然后停留，点击翻页。\n- 第4页：标题自动入场，两个对比内容各等待一次点击。\n- 第5页：标题自动入场，每次点击同时显示一个步骤的标记、编号和正文。\n- 每页之间柔和淡化，内容展开后不会自行翻页。\n\n请分别在 PowerPoint 和 WPS 中放映 animated.pptx，记录版本、问题页码和具体表现。真实播放和主观观感尚未验收。static.pptx 可用于人工微调后重新上传。\n');
  return { directory, files, report: result.report };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await createPresenterDemo(), null, 2));
