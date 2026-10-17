import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { structureText } from '../src/outline.js';
import { generatePptx } from '../src/presentation.js';
import { animatePptx, inspectPptx } from '../src/animation.js';

const cases = [
  { path: '01-static.pptx', kind: 'static' },
  { path: '02-click-fade.pptx', kind: 'animated', settings: { effect: 'fade', trigger: 'click', duration: 700, transition: 'fade' } },
  { path: '03-auto-fade.pptx', kind: 'animated', settings: { effect: 'fade', trigger: 'auto', duration: 1000, stagger: 500, transition: 'fade' } },
  { path: '04-click-appear.pptx', kind: 'animated', settings: { effect: 'appear', trigger: 'click', transition: 'none' } },
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function createAcceptancePack(outputRoot = fileURLToPath(new URL('../artifacts/', import.meta.url))) {
  await mkdir(outputRoot, { recursive: true });
  // Every run gets a new directory. Never overwrite human playback evidence.
  const directory = await mkdtemp(join(resolve(outputRoot), 'acceptance-'));
  const source = await readFile(new URL('../examples/brief.md', import.meta.url), 'utf8');
  const original = await generatePptx(structureText(source));
  const files = [];
  for (const entry of cases) {
    const converted = entry.settings ? await animatePptx(original, entry.settings) : { buffer: original };
    const inventory = await inspectPptx(converted.buffer);
    const record = { ...entry, sha256: sha256(converted.buffer), bytes: converted.buffer.length, slides: inventory.slides.length, objects: inventory.slides.reduce((sum, slide) => sum + slide.shapes.length, 0) };
    if (converted.report) record.report = converted.report;
    files.push(record);
    await writeFile(join(directory, entry.path), converted.buffer);
  }
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generationMode: 'source',
    aiProviderValidated: false,
    powerPointPlaybackValidated: false,
    files,
    manualChecks: [
      { id: 'model-generation', name: '真实模型生成', status: 'pending' },
      { id: 'open-static', name: 'PowerPoint 打开与中文显示', status: 'pending' },
      { id: 'manual-edit-import', name: '人工调整、保存、重新上传', status: 'pending' },
      { id: 'click-fade', name: '逐个单击淡入', status: 'pending' },
      { id: 'auto-fade', name: '上一项完成后自动淡入', status: 'pending' },
      { id: 'click-appear', name: '逐个单击出现', status: 'pending' },
      { id: 'selective-animation', name: '只为勾选对象添加动画', status: 'pending' },
    ],
  };
  await writeFile(join(directory, 'source.md'), source);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(directory, 'CHECKLIST.md'), checklist(files));
  await writeFile(join(directory, 'manual-results.md'), `# 人工验收记录\n\n状态：待验收\n\n- 操作系统：\n- PowerPoint 版本：\n- 验收日期与人员：\n- 使用的 PPTX 文件及其 SHA-256：\n\n| 检查项 | 结果（待验收 / 通过 / 失败） | 证据文件或具体表现 |\n| --- | --- | --- |\n${manifest.manualChecks.map(check => `| ${check.name} | 待验收 | |`).join('\n')}\n\n## 问题记录\n\n请记录发生问题的页码、具体对象、实际操作和预期结果。失败的原始文件请另存保留，避免覆盖。\n`);
  return { directory, manifest };
}
function checklist(files) {
  const baseline = files.find(file => file.kind === 'static');
  return `# PowerPoint 两阶段验收\n\n这是待验收样本包。由本地原文分页生成，未调用真实模型；自动生成成功不代表已验证 PowerPoint 编辑或放映。实际结果请填写同目录 manual-results.md。\n\n## 文件与预期\n\n| 文件 | 用途与预期行为 |\n| --- | --- |\n| 01-static.pptx | ${baseline.slides} 页静态文件，原生文字可编辑，没有入场动画 |\n| 02-click-fade.pptx | 每次单击推进一个对象，淡入时长设为 0.7 秒 |\n| 03-auto-fade.pptx | 每页对象依次自动淡入，效果时长设为 1 秒，后续对象间隔设为 0.5 秒 |\n| 04-click-appear.pptx | 每次单击显示一个对象，不添加页面切换 |\n\n示例共有 ${baseline.objects} 个可选内容对象。页码与底部细线保持静态。每页的预期对象顺序为：标题，随后正文 1、正文 2、正文 3。首张封面只有标题。source.md 是输入材料，manifest.json 记录各文件的字节数、SHA-256 和参数，方便确认验收的是哪份文件。\n\n## 静态生成与人工调整\n\n1. 使用 Microsoft PowerPoint 打开 01-static.pptx，记录是否出现文件修复提示、中文缺字或布局异常。\n2. 进入第二页，双击第一个正文文本框，改成“人工调整后的正文”。文字应可直接编辑。\n3. 移动这个文本框，新增文本框“人工新增内容”，再将最后一页移到第二页。\n4. 将结果另存为自己的新 PPTX，保留本包的基准文件。\n5. 在本地工作台 http://127.0.0.1:3210 的“转换动态 PPTX”中上传这份人工调整文件。应能看到新页序、修改后的文字，以及“人工新增内容”。\n6. 选择“淡入、逐个单击”并下载。再次用 PowerPoint 打开，检查手动修改的文字、位置、页序和新增对象是否保留，放映时是否按选定对象播放。\n\n## 入场与播放顺序\n\n1. 打开 02-click-fade.pptx，从头放映。内容对象在尚未触发时不应提前显示，页脚静态显示。每次单击只推进一个对象；内容全部出现后再单击才进入下一页。\n2. 打开 03-auto-fade.pptx。进入每页后无需逐个单击，对象应按顺序出现，后一项在上一项完成后按设定间隔继续。页面之间仍由你手动切换。记录实际时序，不用 XML 参数代替观察结果。\n3. 打开 04-click-appear.pptx。逐次单击应立即显示对应对象。\n4. 回到工作台，重新上传 01-static.pptx，仅勾选第二页一条正文后导出：其他对象应静态显示，只有这一条正文参加入场。\n5. 将已有动画的结果再次上传，保留默认设置导出：原有动画应保留。显式勾选替换时，再检查该页是否重建为本次设置。\n\n## 真实模型\n\n在项目 .env 中填写自己的模型地址、模型名和密钥，重启后选择 AI 编排。请使用你实际准备演示的材料，检查生成重点与事实是否准确，并把该文件也走一遍静态编辑和动画流程。密钥留在本地 .env，验收记录只填写服务名称、模型名和结果。\n\n## 留证\n\n将 PowerPoint 版本、待验收文件的 SHA-256、问题页码与实际表现填写到 manual-results.md，可附截图或屏幕录制。人工调整文件和动画结果另存保留。再次执行 npm run acceptance 会生成新目录，不覆盖本目录的记录。\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await createAcceptancePack();
    console.log(`已生成待验收样本包：${result.directory}`);
    console.log('请打开 CHECKLIST.md；真实模型和 PowerPoint 放映仍标记为待验收。');
  } catch (error) { console.error(`生成验收包失败：${error.message}`); process.exitCode = 1; }
}
