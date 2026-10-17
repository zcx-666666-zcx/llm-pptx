import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { inspectPptx } from './animation.js';
import { NS, elements, loadPackage, readXml, parseXml, serialize, descendants } from './package.js';

export const cinematicSettings = z.object({
  style: z.enum(['aurora', 'silk', 'ember']).default('aurora'),
  slideSeconds: z.coerce.number().min(4).max(20).default(7),
  transitionSeconds: z.coerce.number().min(0.8).max(2.4).default(1.4),
  motion: z.enum(['gentle', 'flow']).default('gentle'),
  loop: z.boolean().default(true),
});
const runtime = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies');
const existing = async candidates => { for (const file of candidates.filter(Boolean)) { try { await fs.access(file, fs.constants.X_OK); return file; } catch {} } return null; };
async function executable(envName, name, extra = []) {
  return existing([process.env[envName], ...(process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, name)), ...extra]);
}
export async function cinematicTools() {
  const tools = {
    ffmpeg: await executable('FFMPEG_PATH', 'ffmpeg'),
    python: await executable('MOTION_PYTHON', 'python3', [path.join(runtime, 'python/bin/python3')]),
    office: await executable('SOFFICE_PATH', 'soffice', ['/Applications/LibreOffice.app/Contents/MacOS/soffice', path.join(runtime, 'bin/override/soffice')]),
    pdf: await executable('PDFTOPPM_PATH', 'pdftoppm', [path.join(runtime, 'bin/override/pdftoppm')]),
  };
  // Prefer the bundled Python when no explicit runtime was selected: it includes Pillow and NumPy.
  if (!process.env.MOTION_PYTHON) tools.python = await existing([path.join(runtime, 'python/bin/python3'), tools.python]);
  return tools;
}
export async function cinematicCapabilities() {
  const tools = await cinematicTools();
  const missing = Object.entries(tools).filter(([, value]) => !value).map(([name]) => name);
  if (tools.python) {
    try { await run(tools.python, ['-c', 'import PIL, numpy'], { timeout: 10000 }); }
    catch { missing.push('Pillow / NumPy'); }
  }
  return { available: missing.length === 0, missing, fps: 30, width: 1280, format: 'H.264 MP4 / 内嵌视频 PPTX' };
}
function run(command, args, { cwd, env, signal, timeout = 240000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env || process.env, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', chunk => { const text = chunk.toString(); stdout = (stdout + text).slice(-16000); pending += text; let end; while ((end = pending.indexOf('\n')) >= 0) { onLine?.(pending.slice(0, end)); pending = pending.slice(end + 1); } });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve({ stdout, stderr }); else reject(new Error(`渲染工具未能完成（${path.basename(command)}，${code ?? '已停止'}）`)); });
  });
}
// Pixel-only background keying cannot distinguish a transparent ring from a
// solid plate painted in the background color. Authorize enclosed-hole removal
// only for simple native artwork with explicit, unambiguous fills.
export async function cinematicBackdropHints(buffer) {
  const zip = await loadPackage(buffer);
  const pres = await readXml(zip, 'ppt/presentation.xml');
  const rels = await readXml(zip, 'ppt/_rels/presentation.xml.rels');
  const cached = new Map();
  const part = file => {
    if (!cached.has(file)) cached.set(file, readXml(zip, file));
    return cached.get(file);
  };
  const related = async (file, kind) => {
    const relFile = path.posix.join(path.posix.dirname(file), '_rels', path.posix.basename(file) + '.rels');
    const doc = await part(relFile);
    const rel = descendants(doc, NS.rel, 'Relationship').find(node => node.getAttribute('Type').endsWith('/' + kind) && node.getAttribute('TargetMode') !== 'External');
    if (!rel) return null;
    const target = rel.getAttribute('Target');
    const resolved = path.posix.normalize(target.startsWith('/') ? target.slice(1) : path.posix.join(path.posix.dirname(file), target));
    return resolved.startsWith('ppt/') ? resolved : null;
  };
  const direct = (node, name) => elements(node).find(child => child.namespaceURI === NS.a && child.localName === name);
  const rgb = node => {
    if (!node || elements(node).length !== 1) return null;
    const color = direct(node, 'srgbClr'), value = color?.getAttribute('val');
    if (!/^[a-f\d]{6}$/i.test(value || '')) return null;
    const transforms = elements(color);
    if (transforms.some(child => child.localName !== 'alpha' || child.namespaceURI !== NS.a)) return null;
    const alpha = transforms.length ? Number(transforms[0].getAttribute('val')) : 100000;
    if (!Number.isInteger(alpha) || alpha < 0 || alpha > 100000) return null;
    return { channels: value.match(/../g).map(channel => parseInt(channel, 16)), alpha };
  };
  const emptyTree = doc => {
    const tree = descendants(doc, NS.p, 'spTree')[0];
    return tree && elements(tree).every(node => node.namespaceURI === NS.p && ['nvGrpSpPr', 'grpSpPr'].includes(node.localName));
  };
  const safeFill = (props, background, translucentStroke = false) => {
    if (direct(props, 'noFill')) return true;
    const color = rgb(direct(props, 'solidFill'));
    return !!color && (color.alpha === 0 || ((color.alpha === 100000 || translucentStroke) && Math.max(...color.channels.map((value, i) => Math.abs(value - background[i]))) > 18));
  };
  return Promise.all(presentationSlideEntries(pres, rels).map(async ({ file }) => {
    const rejected = { clearEnclosedBackground: false };
    try {
      const doc = await part(file);
      const bgPr = descendants(doc, NS.p, 'bgPr')[0];
      const color = bgPr && rgb(direct(bgPr, 'solidFill'));
      if (!color || color.alpha !== 100000 || descendants(doc, NS.p, 'style').length) return rejected;
      if (elements(bgPr).some(node => node.localName !== 'solidFill' && (node.localName !== 'effectLst' || elements(node).length))) return rejected;
      const layout = await related(file, 'slideLayout');
      const master = layout && await related(layout, 'slideMaster');
      if (!layout || !master || !emptyTree(await part(layout)) || !emptyTree(await part(master))) return rejected;
      const tree = descendants(doc, NS.p, 'spTree')[0];
      if (!tree) return rejected;
      for (const node of elements(tree)) {
        if (node.namespaceURI !== NS.p) return rejected;
        if (['nvGrpSpPr', 'grpSpPr'].includes(node.localName)) continue;
        if (!['sp', 'cxnSp'].includes(node.localName)) return rejected;
        const props = elements(node).find(child => child.namespaceURI === NS.p && child.localName === 'spPr');
        if (!props || !direct(props, 'prstGeom') || !safeFill(props, color.channels)) return rejected;
        if (elements(props).some(child => ['gradFill', 'blipFill', 'pattFill', 'grpFill', 'scene3d', 'sp3d', 'effectDag'].includes(child.localName))) return rejected;
        if (descendants(node, NS.a, 'effectLst').some(effect => elements(effect).length)) return rejected;
        for (const text of descendants(node, NS.a, 't')) {
          const runProps = direct(text.parentNode, 'rPr');
          if (!runProps || !safeFill(runProps, color.channels)) return rejected;
        }
        const line = direct(props, 'ln');
        if (line && elements(line).length && !safeFill(line, color.channels, true)) return rejected;
      }
      return { clearEnclosedBackground: true, backgroundColor: color.channels };
    } catch { return rejected; }
  }));
}
export async function renderCinematic(buffer, options = {}, { directory, signal, onProgress = () => {} } = {}) {
  const settings = cinematicSettings.parse(options);
  const info = await inspectPptx(buffer);
  if (info.slides.length > 30 || info.slides.length * settings.slideSeconds > 300) throw new Error('连续动态演示每次最多 30 页、总时长不超过 5 分钟，请拆分文件或缩短每页时长');
  const tools = await cinematicTools();
  if (Object.values(tools).some(value => !value)) throw new Error('连续渲染需要 LibreOffice、FFmpeg、pdftoppm 和含 Pillow/NumPy 的 Python，请检查渲染环境');
  const dir = directory || await fs.mkdtemp(path.join(os.tmpdir(), 'llm-pptx-motion-'));
  await fs.mkdir(dir, { recursive: true });
  const input = path.join(dir, 'source.pptx'); await fs.writeFile(input, buffer);
  const frames = path.join(dir, 'pages'); await fs.mkdir(frames, { recursive: true });
  let env = { ...process.env };
  if (process.platform === 'darwin') {
    const config = path.join(dir, 'fonts.conf');
    await fs.writeFile(config, `<?xml version="1.0"?><fontconfig><dir>/System/Library/Fonts</dir><dir>/System/Library/Fonts/Supplemental</dir><dir>/Library/Fonts</dir><cachedir>${dir}/font-cache</cachedir><alias><family>Microsoft YaHei</family><prefer><family>Heiti SC</family></prefer></alias></fontconfig>`);
    env.FONTCONFIG_FILE = config;
  }
  onProgress({ phase: 'slides', progress: 4, message: '正在读取调整后的页面与字体…' });
  await run(tools.office, [`-env:UserInstallation=${new URL(`file://${dir}/office-profile`).href}`, '--headless', '--convert-to', 'pdf', '--outdir', dir, input], { env, signal });
  try { await fs.access(path.join(dir, 'source.pdf')); } catch { throw new Error('无法将上传的 PPTX 渲染为页面，请先用 PowerPoint 另存为标准 PPTX'); }
  await run(tools.pdf, ['-png', '-scale-to', '1280', path.join(dir, 'source.pdf'), path.join(frames, 'page')], { env, signal });
  const pages = (await fs.readdir(frames)).filter(name => /^page-\d+\.png$/.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (pages.length !== info.slides.length) throw new Error('页面渲染数量与源文件不一致，未生成不完整的演示');
  const backdropHints = await cinematicBackdropHints(buffer);
  const spec = { ...settings, backdropHints, fps: 30, width: 1280, height: 720, pages: pages.map(name => path.join(frames, name)), ffmpeg: tools.ffmpeg, video: path.join(dir, 'motion.mp4'), poster: path.join(dir, 'poster.png') };
  const specFile = path.join(dir, 'render.json'); await fs.writeFile(specFile, JSON.stringify(spec));
  onProgress({ phase: 'rendering', progress: 15, message: '正在合成流动背景、连续运动与平滑转场…' });
  await run(tools.python, [new URL('../scripts/render_motion.py', import.meta.url).pathname, specFile], { env, signal, timeout: 15 * 60000, onLine: line => { try { const event = JSON.parse(line); onProgress({ phase: 'rendering', ...event }); } catch {} } });
  if (signal?.aborted) throw new Error('已停止生成');
  onProgress({ phase: 'packaging', progress: 95, message: '正在打包影片版与原生 Morph 版 PPTX，并保留源页面…' });
  const video = await fs.readFile(spec.video), cover = await fs.readFile(spec.poster);
  const duration = pages.length * settings.slideSeconds;
  const pptxPath = path.join(dir, 'motion.pptx');
  const nativePptxPath = path.join(dir, 'native-motion.pptx');
  await fs.writeFile(pptxPath, await packagePlaybackPptx(buffer, video, cover, { duration, loop: settings.loop }));
  let nativeMotionAvailable = true;
  let nativeMotionError = null;
  try { await fs.writeFile(nativePptxPath, await packageMorphPptx(buffer, settings)); }
  catch (error) { nativeMotionAvailable = false; nativeMotionError = error.message; }
  const report = { sourceSlides: pages.length, duration, fps: 30, width: 1280, height: 720, ...settings, sourceRetained: true, nativeMotionAvailable, ...(nativeMotionError ? { nativeMotionError } : {}), powerPointPlaybackValidated: false };
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  return { directory: dir, videoPath: spec.video, posterPath: spec.poster, pptxPath, nativePptxPath, sourcePath: input, report };
}

export async function packagePlaybackPptx(source, video, cover, { duration, loop = true } = {}) {
  const zip = await loadPackage(source);
  const pres = await readXml(zip, 'ppt/presentation.xml'), rels = await readXml(zip, 'ppt/_rels/presentation.xml.rels');
  const types = await readXml(zip, '[Content_Types].xml');
  const ids = descendants(pres, NS.p, 'sldId');
  if (!ids.length) throw new Error('原演示没有页面');
  const token = randomUUID(), slideName = `motion-${token}.xml`, movie = `motion-${token}.mp4`, poster = `motion-${token}.png`;
  const size = descendants(pres, NS.p, 'sldSz')[0];
  const width = Number(size?.getAttribute('cx')), height = Number(size?.getAttribute('cy'));
  if (!(width > 0 && height > 0)) throw new Error('原演示页面尺寸无效');
  const mediaId = `rIdMotion${token.replaceAll('-', '')}`;
  const newSlideId = Math.max(255, ...ids.map(n => Number(n.getAttribute('id')))) + 1;
  const mapping = new Map(descendants(rels, NS.rel, 'Relationship').map(n => [n.getAttribute('Id'), n.getAttribute('Target')]));
  let layout;
  for (const id of ids) {
    const target = mapping.get(id.getAttributeNS(NS.r, 'id'));
    const file = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`ppt/${target}`);
    const slide = await readXml(zip, file); slide.documentElement.setAttribute('show', '0'); zip.file(file, serialize(slide));
    if (!layout) {
      const slideRels = await readXml(zip, path.posix.join(path.posix.dirname(file), '_rels', `${path.posix.basename(file)}.rels`));
      const layoutRel = descendants(slideRels, NS.rel, 'Relationship').find(n => n.getAttribute('Type').endsWith('/slideLayout'));
      if (layoutRel) { const target = layoutRel.getAttribute('Target'); const absolute = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(file), target)); layout = path.posix.relative('ppt/slides', absolute); }
    }
  }
  if (!layout) throw new Error('原演示缺少页面版式关系');
  // The renderer produces a 16:9 movie even when the source uses another canvas.
  // Fit the movie without changing the dimensions of the retained editable pages.
  const movieWidth = Math.min(width, Math.round(height * 16 / 9));
  const movieHeight = Math.min(height, Math.round(width * 9 / 16));
  const movieX = Math.floor((width - movieWidth) / 2);
  const movieY = Math.floor((height - movieHeight) / 2);
  const repeated = loop ? ' repeatCount="indefinite"' : '';
  // A single movie includes the cross-page transitions, avoiding media restarts between slides.
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}" showMasterSp="0"><p:cSld name="连续动态演示"><p:bg><p:bgPr><a:solidFill><a:srgbClr val="0B141B"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:pic><p:nvPicPr><p:cNvPr id="2" name="连续播放影片"><a:hlinkClick r:id="" action="ppaction://media"/></p:cNvPr><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr><a:videoFile r:link="rId1"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="rId2"/></p:ext></p:extLst></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${movieX}" y="${movieY}"/><a:ext cx="${movieWidth}" cy="${movieHeight}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr><p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:par><p:cTn id="2" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:video><p:cMediaNode vol="0" showWhenStopped="1"><p:cTn id="3" dur="${Math.round(duration * 1000)}" fill="hold"${repeated}><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="2"/></p:tgtEl></p:cMediaNode></p:video></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing></p:sld>`;
  zip.file(`ppt/slides/${slideName}`, xml);
  const relationship = (id, type, target) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`;
  const relPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  // Layout paths come from validated package relationships; serialize through the XML DOM for escaping.
  const slideRels = parseXml(`<Relationships xmlns="${NS.rel}">${relationship('rId1', `${relPrefix}/video`, `../media/${movie}`)}${relationship('rId2', 'http://schemas.microsoft.com/office/2007/relationships/media', `../media/${movie}`)}${relationship('rId3', `${relPrefix}/image`, `../media/${poster}`)}</Relationships>`);
  const layoutNode = slideRels.createElementNS(NS.rel, 'Relationship'); layoutNode.setAttribute('Id', 'rId4'); layoutNode.setAttribute('Type', `${relPrefix}/slideLayout`); layoutNode.setAttribute('Target', layout); slideRels.documentElement.appendChild(layoutNode);
  zip.file(`ppt/slides/_rels/${slideName}.rels`, serialize(slideRels));
  zip.file(`ppt/media/${movie}`, video); zip.file(`ppt/media/${poster}`, cover);
  const slideId = pres.createElementNS(NS.p, 'p:sldId'); slideId.setAttribute('id', String(newSlideId)); slideId.setAttributeNS(NS.r, 'r:id', mediaId);
  ids[0].parentNode.insertBefore(slideId, ids[0]);
  const rel = rels.createElementNS(NS.rel, 'Relationship'); rel.setAttribute('Id', mediaId); rel.setAttribute('Type', `${relPrefix}/slide`); rel.setAttribute('Target', `slides/${slideName}`); rels.documentElement.appendChild(rel);
  const ct = 'http://schemas.openxmlformats.org/package/2006/content-types';
  for (const [extension, contentType] of [['mp4', 'video/mp4'], ['png', 'image/png']]) {
    if (!descendants(types, ct, 'Default').some(n => n.getAttribute('Extension').toLowerCase() === extension)) { const node = types.createElementNS(ct, 'Default'); node.setAttribute('Extension', extension); node.setAttribute('ContentType', contentType); types.documentElement.appendChild(node); }
  }
  const override = types.createElementNS(ct, 'Override'); override.setAttribute('PartName', `/ppt/slides/${slideName}`); override.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml'); types.documentElement.appendChild(override);
  zip.file('ppt/presentation.xml', serialize(pres)); zip.file('ppt/_rels/presentation.xml.rels', serialize(rels)); zip.file('[Content_Types].xml', serialize(types));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const P14_NS = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const P159_NS = 'http://schemas.microsoft.com/office/powerpoint/2015/09/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';

function presentationSlideEntries(pres, rels) {
  const mapping = new Map(descendants(rels, NS.rel, 'Relationship').filter(node => node.getAttribute('TargetMode') !== 'External').map(node => [node.getAttribute('Id'), node]));
  return descendants(pres, NS.p, 'sldId').map((id, index) => {
    const relationship = mapping.get(id.getAttributeNS(NS.r, 'id'));
    if (!relationship || !relationship.getAttribute('Type').endsWith('/slide')) throw new Error('PPTX 幻灯片关系损坏');
    const target = relationship.getAttribute('Target');
    const file = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`ppt/${target}`);
    if (!file.startsWith('ppt/slides/')) throw new Error('PPTX 幻灯片路径异常');
    return { index, file, relationship };
  });
}

function transformMotion(doc, slideIndex, frameIndex, keyframes, width, height, motion) {
  const tree = descendants(doc, NS.p, 'spTree')[0];
  if (!tree) return 0;
  const shapes = elements(tree).filter(node => ['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp'].includes(node.localName));
  const phase = (frameIndex / keyframes) * Math.PI * 2;
  const intensity = motion === 'flow' ? 1 : .35;
  const boundary = frameIndex === 0 || frameIndex === keyframes - 1;
  let changed = 0;
  for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex++) {
    const shape = shapes[shapeIndex];
    const cNvPr = descendants(shape, NS.p, 'cNvPr')[0];
    const xfrm = elements(shape).find(node => node.localName === 'xfrm') || descendants(shape, NS.a, 'xfrm')[0];
    if (!cNvPr || !xfrm) continue;
    const off = descendants(xfrm, NS.a, 'off')[0];
    const ext = descendants(xfrm, NS.a, 'ext')[0];
    const x = Number(off?.getAttribute('x')), y = Number(off?.getAttribute('y'));
    const cx = Number(ext?.getAttribute('cx')), cy = Number(ext?.getAttribute('cy'));
    if (![x, y, cx, cy].every(Number.isFinite) || cx <= 0 || cy < 0) continue;
    const id = Number(cNvPr.getAttribute('id')) || shapeIndex + 2;
    const seed = ((id * .61803398875 + slideIndex * 1.37 + shapeIndex * .41) % 7) - 3.5;
    const isBackground = cx >= width * .86 && cy >= height * .86;
    cNvPr.setAttribute('name', `!!llmpptx:${slideIndex}:${id}`);
    if (isBackground) continue;
    const hasText = descendants(shape, NS.a, 't').some(node => node.textContent.trim());
    const geometry = descendants(shape, NS.a, 'prstGeom')[0]?.getAttribute('prst');
    const ornament = !hasText && ['arc', 'blockArc', 'circularArrow', 'leftCircularArrow', 'ellipse'].includes(geometry);
    const fontSizes = [...descendants(shape, NS.a, 'rPr'), ...descendants(shape, NS.a, 'defRPr')].map(node => Number(node.getAttribute('sz')) || 0);
    const title = hasText && Math.max(0, ...fontSizes) >= 2800;
    const visual = ornament || shape.localName === 'pic';
    const dx = Math.round(width * (title ? .018 : visual ? .020 : .008) * intensity * Math.sin(phase + seed));
    const dy = Math.round(height * (title ? .018 : visual ? .022 : .009) * intensity * Math.cos(phase + seed));
    // Preserve text box metrics so animation cannot reflow paragraphs.
    const scale = visual ? 1 + .035 * intensity * Math.sin(phase + seed * .7) : 1;
    const newCx = Math.max(1, Math.round(cx * scale)), newCy = Math.max(0, Math.round(cy * scale));
    off.setAttribute('x', String(Math.round(x + dx - (newCx - cx) / 2)));
    off.setAttribute('y', String(Math.round(y + dy - (newCy - cy) / 2)));
    ext.setAttribute('cx', String(newCx)); ext.setAttribute('cy', String(newCy));
    if (ornament) {
      const rotation = Number(xfrm.getAttribute('rot')) || 0;
      xfrm.setAttribute('rot', String(Math.round(rotation + 60 * 60000 * intensity * Math.sin(phase + seed))));
    } else if (boundary) {
      // Text and photos leave the canvas before a scene changes. Keep both
      // endpoints below the page so a one-page loop cannot sweep text through
      // the canvas while returning from its last keyframe to its first.
      off.setAttribute('y', String(Math.round(height + cy + height * .04)));
    }
    changed++;
  }
  return changed;
}

function nativeFrameDurations(settings) {
  const total = Math.round(settings.slideSeconds * 1000);
  const boundary = 100;
  const entranceExit = Math.min(Math.round(settings.transitionSeconds * 500), Math.floor((total - boundary) / 3));
  const holdCount = settings.keyframes - 3;
  if (holdCount === 0) return [boundary, total - boundary - entranceExit, entranceExit];
  const holdTotal = total - boundary - entranceExit * 2;
  return [boundary, entranceExit, ...Array.from({ length: holdCount }, (_, index) => Math.floor(holdTotal / holdCount) + (index < holdTotal % holdCount ? 1 : 0)), entranceExit];
}

function appendAmbientFields(doc, slideIndex, frameIndex, slides, frameDurations, width, height, settings) {
  const colors = { aurora: ['29A597', '4C77C9', 'CFAE6D'], silk: ['5F8EC7', 'A9BED3', '5DA5BB'], ember: ['CB8A56', 'BB7387', 'C6AA77'] }[settings.style];
  const tree = descendants(doc, NS.p, 'spTree')[0];
  if (!tree) return;
  const ids = descendants(doc, NS.p, 'cNvPr').map(node => Number(node.getAttribute('id'))).filter(Number.isFinite);
  const firstId = Math.max(1, ...ids) + 1;
  const anchor = elements(tree).find(node => !['nvGrpSpPr', 'grpSpPr'].includes(node.localName));
  const duration = slides * settings.slideSeconds;
  const elapsed = slideIndex * settings.slideSeconds + frameDurations.slice(0, frameIndex).reduce((sum, value) => sum + value, 0) / 1000;
  const wave = 2 * Math.PI * elapsed * Math.max(1, Math.round(duration / 8)) / duration;
  const intensity = settings.motion === 'flow' ? 1 : .45;
  const rings = 24;
  for (let index = 0; index < colors.length; index++) {
    const diameter = Math.round(width * (.65 + index * .07));
    const x = Math.round(width * (.5 + .24 * intensity * Math.sin(wave + index * 2.1)) - diameter / 2);
    const y = Math.round(height * (.5 + .28 * intensity * Math.cos(wave + index * 2.3)) - diameter / 2);
    const id = firstId + index * (rings + 1);
    let previousOpacity = 0;
    const discs = Array.from({ length: rings }, (_, ring) => {
      const size = Math.round(diameter * (1 - ring / rings));
      const offset = Math.round((diameter - size) / 2);
      const opacity = .18 * ((ring + 1) / rings) ** 2;
      const alpha = Math.round((opacity - previousOpacity) / (1 - previousOpacity) * 100000);
      previousOpacity = opacity;
      return `<p:sp><p:nvSpPr><p:cNvPr id="${id + ring + 1}" name="!!llmpptx:light:${index}:${ring}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${offset}" y="${offset}"/><a:ext cx="${size}" cy="${size}"/></a:xfrm><a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${colors[index]}"><a:alpha val="${alpha}"/></a:srgbClr></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
    }).join('');
    // Some Office readers lose the varying alpha of a path gradient. Solid
    // translucent discs provide explicit alpha steps and remain editable as
    // a single moving group.
    const xml = `<p:grpSp xmlns:p="${NS.p}" xmlns:a="${NS.a}"><p:nvGrpSpPr><p:cNvPr id="${id}" name="!!llmpptx:ambient:${index}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${diameter}" cy="${diameter}"/><a:chOff x="0" y="0"/><a:chExt cx="${diameter}" cy="${diameter}"/></a:xfrm></p:grpSpPr>${discs}</p:grpSp>`;
    tree.insertBefore(doc.importNode(parseXml(xml).documentElement, true), anchor || null);
  }
}

function stripSlidePlaybackNodes(doc) {
  const root = doc.documentElement;
  for (const child of [...elements(root)]) {
    if (child.localName === 'timing' || child.localName === 'transition') root.removeChild(child);
    if (child.namespaceURI === MC_NS && child.localName === 'AlternateContent' && descendants(child, NS.p, 'transition').length) root.removeChild(child);
  }
}

function morphTransitionXml(transitionDuration) {
  return `<mc:AlternateContent xmlns:mc="${MC_NS}"><mc:Choice xmlns:p159="${P159_NS}" Requires="p159"><p:transition xmlns:p14="${P14_NS}" spd="slow" advTm="0" advClick="0" p14:dur="${transitionDuration}"><p159:morph option="byObject"/></p:transition></mc:Choice><mc:Fallback><p:transition spd="slow" advTm="0" advClick="0"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>`;
}

function insertMorphTransition(doc, transitionDuration) {
  const root = doc.documentElement;
  const node = doc.importNode(parseXml(`<root xmlns:p="${NS.p}">${morphTransitionXml(transitionDuration)}</root>`).documentElement.firstChild, true);
  const anchor = elements(root).find(child => child.localName === 'timing' || child.localName === 'extLst');
  root.insertBefore(node, anchor || null);
}

async function updatePresentationShowProperties(zip, { loop }) {
  const file = 'ppt/presProps.xml';
  const doc = await readXml(zip, file);
  const presentationPr = descendants(doc, NS.p, 'presentationPr')[0] || doc.documentElement;
  let showPr = descendants(presentationPr, NS.p, 'showPr')[0];
  if (!showPr) {
    showPr = doc.createElementNS(NS.p, 'p:showPr');
    presentationPr.appendChild(showPr);
  }
  showPr.setAttribute('useTimings', '1');
  showPr.setAttribute('showAnimation', '1');
  showPr.setAttribute('loop', loop ? '1' : '0');
  zip.file(file, serialize(doc));
}

async function cloneNativeSlideRelationships(zip, sourceFile, slideName, bytes, notesOverrides) {
  const rels = parseXml(bytes.toString('utf8'));
  for (const rel of descendants(rels, NS.rel, 'Relationship').filter(node => node.getAttribute('Type').endsWith('/notesSlide'))) {
    if (rel.getAttribute('TargetMode') === 'External') throw new Error('原演示备注必须保存在 PPTX 文件内');
    const target = rel.getAttribute('Target');
    const sourceNotes = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), target));
    const notesName = `notes-${slideName}`;
    const notesFile = `ppt/notesSlides/${notesName}`;
    const originalNotes = zip.file(sourceNotes);
    if (!originalNotes) throw new Error('原演示备注文件缺失');
    const oldNotesRels = path.posix.join(path.posix.dirname(sourceNotes), '_rels', `${path.posix.basename(sourceNotes)}.rels`);
    const notesRels = await readXml(zip, oldNotesRels);
    for (const noteRel of descendants(notesRels, NS.rel, 'Relationship')) {
      if (noteRel.getAttribute('Type').endsWith('/slide')) {
        noteRel.setAttribute('Target', `../slides/${slideName}`);
      } else if (noteRel.getAttribute('TargetMode') !== 'External') {
        const oldTarget = noteRel.getAttribute('Target');
        const resolved = oldTarget.startsWith('/') ? oldTarget.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(sourceNotes), oldTarget));
        noteRel.setAttribute('Target', path.posix.relative('ppt/notesSlides', resolved));
      }
    }
    zip.file(notesFile, await originalNotes.async('nodebuffer'));
    zip.file(`ppt/notesSlides/_rels/${notesName}.rels`, serialize(notesRels));
    rel.setAttribute('Target', `../notesSlides/${notesName}`);
    notesOverrides.push(notesFile);
  }
  zip.file(`ppt/slides/_rels/${slideName}.rels`, serialize(rels));
}

/**
 * Create an editable native-motion deck. Each source slide becomes a short
 * sequence of editable keyframes. PowerPoint interpolates matching objects
 * with Morph; older readers use the fade fallback in the same package.
 */
export async function packageMorphPptx(source, options = {}) {
  const settings = cinematicSettings.extend({ keyframes: z.coerce.number().int().min(3).max(8).default(6) }).parse(options);
  const zip = await loadPackage(source);
  const pres = await readXml(zip, 'ppt/presentation.xml');
  const rels = await readXml(zip, 'ppt/_rels/presentation.xml.rels');
  const types = await readXml(zip, '[Content_Types].xml');
  const slides = presentationSlideEntries(pres, rels);
  if (!slides.length || slides.length > 30) throw new Error('原演示页数必须在 1 到 30 页之间');
  const size = descendants(pres, NS.p, 'sldSz')[0];
  const width = Number(size?.getAttribute('cx'));
  const height = Number(size?.getAttribute('cy'));
  if (!(width > 0 && height > 0)) throw new Error('原演示页面尺寸无效');
  const token = randomUUID();
  const frameDurations = nativeFrameDurations(settings);
  const originalIds = descendants(pres, NS.p, 'sldId');
  const newSlideIds = [];
  const relNodes = descendants(rels, NS.rel, 'Relationship');
  let nextSlideId = Math.max(255, ...originalIds.map(node => Number(node.getAttribute('id')))) + 1;
  let relCounter = Math.max(0, ...relNodes.map(node => Number((node.getAttribute('Id') || '').replace(/^rId/, ''))).filter(Number.isFinite)) + 1;
  const overrides = [], notesOverrides = [];
  for (const slide of slides) {
    const original = await readXml(zip, slide.file);
    original.documentElement.setAttribute('show', '0');
    zip.file(slide.file, serialize(original));
    const relFile = path.posix.join(path.posix.dirname(slide.file), '_rels', `${path.posix.basename(slide.file)}.rels`);
    const relationBytes = zip.file(relFile) ? await zip.file(relFile).async('nodebuffer') : null;
    for (let frame = 0; frame < settings.keyframes; frame++) {
      const dynamic = await readXml(zip, slide.file);
      dynamic.documentElement.removeAttribute('show');
      stripSlidePlaybackNodes(dynamic);
      transformMotion(dynamic, slide.index, frame, settings.keyframes, width, height, settings.motion);
      appendAmbientFields(dynamic, slide.index, frame, slides.length, frameDurations, width, height, settings);
      insertMorphTransition(dynamic, frameDurations[frame]);
      const name = `morph-${token}-${String(slide.index + 1).padStart(2, '0')}-${String(frame + 1).padStart(2, '0')}.xml`;
      const target = `slides/${name}`;
      const relId = `rIdMorph${relCounter++}`;
      const slideId = pres.createElementNS(NS.p, 'p:sldId');
      slideId.setAttribute('id', String(nextSlideId++));
      slideId.setAttributeNS(NS.r, 'r:id', relId);
      newSlideIds.push(slideId);
      const relationship = rels.createElementNS(NS.rel, 'Relationship');
      relationship.setAttribute('Id', relId);
      relationship.setAttribute('Type', `${REL_NS}/slide`);
      relationship.setAttribute('Target', target);
      rels.documentElement.appendChild(relationship);
      zip.file(`ppt/slides/${name}`, serialize(dynamic));
      if (relationBytes) await cloneNativeSlideRelationships(zip, slide.file, name, relationBytes, notesOverrides);
      overrides.push(name);
    }
  }
  const firstId = originalIds[0];
  for (const node of newSlideIds) firstId.parentNode.insertBefore(node, firstId);
  const ctOverrides = descendants(types, CONTENT_TYPES_NS, 'Override');
  for (const name of overrides) {
    if (ctOverrides.some(node => node.getAttribute('PartName') === `/ppt/slides/${name}`)) continue;
    const node = types.createElementNS(CONTENT_TYPES_NS, 'Override');
    node.setAttribute('PartName', `/ppt/slides/${name}`);
    node.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml');
    types.documentElement.appendChild(node);
  }
  for (const file of notesOverrides) {
    const node = types.createElementNS(CONTENT_TYPES_NS, 'Override');
    node.setAttribute('PartName', `/${file}`);
    node.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml');
    types.documentElement.appendChild(node);
  }
  await updatePresentationShowProperties(zip, { loop: settings.loop });
  zip.file('ppt/presentation.xml', serialize(pres));
  zip.file('ppt/_rels/presentation.xml.rels', serialize(rels));
  zip.file('[Content_Types].xml', serialize(types));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
