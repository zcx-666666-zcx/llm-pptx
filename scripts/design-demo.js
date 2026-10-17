import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { generatePptx } from '../src/presentation.js';
import { planAnimations, applyAnimationPlan } from '../src/animation.js';
const root = resolve('artifacts'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'static-design-'));
const deck = JSON.parse(await readFile(new URL('../public/design-example.json', import.meta.url), 'utf8'));
const files = [];
for (const theme of ['studio', 'ink', 'night']) {
  const buffer = await generatePptx(deck, { theme }), file = `${theme}-static.pptx`;
  await writeFile(join(directory, file), buffer);
  files.push({ file, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
}
const input = await readFile(join(directory, 'studio-static.pptx')), plan = await planAnimations(input), result = await applyAnimationPlan(input, plan);
await writeFile(join(directory, 'studio-animated.pptx'), result.buffer);
files.push({ file: 'studio-animated.pptx', bytes: result.buffer.length, sha256: createHash('sha256').update(result.buffer).digest('hex') });
await writeFile(join(directory, 'animation-plan.json'), JSON.stringify(plan, null, 2));
await writeFile(join(directory, 'verification.json'), JSON.stringify({ generatedAt: new Date().toISOString(), screenshotsTaken: 0, visionUsed: false, templateSource: 'ppt-master/presentation_core', files, ...result.report }, null, 2));
await writeFile(join(directory, 'PLAYBACK.md'), '# 放映核对\n\n共 8 页：封面、分栏、卡片、对比、流程、数字、观点大字、总结。\n\n第 4、5 页先显示标题，然后每次点击展开一个对象组；其他页自动简短入场后停留。翻页均由演讲者控制。数字页是输入规则说明，不是调研数据。\n\n请在 PowerPoint、WPS 中分别放映 studio-animated.pptx，记录软件版本、问题页码与表现。当前报告只证明文件结构与坐标规则通过，实际流畅度和字体排版未验收。\n');
console.log(JSON.stringify({ directory, files, report: result.report }, null, 2));
