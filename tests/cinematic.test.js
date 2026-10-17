import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import PptxGenJS from 'pptxgenjs';
import { XMLSerializer } from '@xmldom/xmldom';
import { generatePptx } from '../src/presentation.js';
import { NS, readXml, descendants } from '../src/package.js';
const exec = promisify(execFile);
const sourceDeck = { title: '连续动态验收', slides: [
  { title: '持续流动的画面', layout: 'cover', subtitle: '人工调整的内容应当保留', bullets: [] },
  { title: '平滑切换下一页', bullets: ['持续播放的背景', '正文保持清晰完整'] },
] };
test('cinematic settings enforce bounded durations and an explicit continuous-motion mode', async () => {
  const { cinematicSettings } = await import('../src/cinematic.js');
  const settings = cinematicSettings.parse({});
  assert.equal(settings.style, 'aurora');
  assert.ok(settings.slideSeconds >= 4);
  assert.ok(settings.transitionSeconds >= 0.8);
  assert.throws(() => cinematicSettings.parse({ slideSeconds: 0 }));
  assert.throws(() => cinematicSettings.parse({ transitionSeconds: 10 }));
});
test('enclosed backdrop removal requires explicit safe native fills and no pictures or inherited artwork', async () => {
  const { cinematicBackdropHints } = await import('../src/cinematic.js');
  const deck = new PptxGenJS(); deck.layout = 'LAYOUT_WIDE';
  for (const kind of ['transparent', 'opaque', 'picture', 'background-text']) {
    const slide = deck.addSlide(); slide.background = { color: '10282F' };
    slide.addShape(deck.ShapeType.ellipse, { x: .1, y: 1, w: 5, h: 5, fill: { color: '10282F', transparency: kind === 'opaque' ? 0 : 100 }, line: { color: '71C6AD', transparency: 9 } });
    slide.addText('正文', { x: 6, y: 2, w: 4, h: 1, color: kind === 'background-text' ? '10282F' : 'FFFFFF', fontSize: 30 });
    slide.addShape(deck.ShapeType.ellipse, { x: 2.5, y: .9, w: .2, h: .2, fill: { color: 'E4C28D' }, line: { color: 'E4C28D' } });
    if (kind === 'picture') slide.addImage({ data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', x: 1, y: 2, w: 1, h: 1 });
  }
  const input = await deck.write({ outputType: 'nodebuffer' });
  const hints = await cinematicBackdropHints(input);
  assert.deepEqual(hints.map(hint => hint.clearEnclosedBackground), [true, false, false, false]);
  assert.deepEqual(hints[0].backgroundColor, [16, 40, 47]);
  const zip = await JSZip.loadAsync(input);
  const master = await readXml(zip, 'ppt/slideMasters/slideMaster1.xml');
  const tree = descendants(master, NS.p, 'spTree')[0];
  const slide = await readXml(zip, 'ppt/slides/slide1.xml');
  tree.appendChild(master.importNode(descendants(slide, NS.p, 'sp')[0], true));
  zip.file('ppt/slideMasters/slideMaster1.xml', new XMLSerializer().serializeToString(master));
  const inherited = await cinematicBackdropHints(await zip.generateAsync({ type: 'nodebuffer' }));
  assert.ok(inherited.every(hint => !hint.clearEnclosedBackground), 'inherited artwork must keep conservative background separation');
});
test('motion choreography clears title overlaps and animates ornaments within long decks', async () => {
  const { cinematicTools } = await import('../src/cinematic.js');
  const tools = await cinematicTools();
  await exec(tools.python, ['tests/motion_choreography.py']);
});
test('the playback PPTX embeds the exact MP4, auto-plays it, and retains editable source slides', async t => {
  const { packagePlaybackPptx } = await import('../src/cinematic.js');
  const source = await generatePptx(sourceDeck);
  const movie = Buffer.from('test-video-bytes');
  const cover = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const output = await packagePlaybackPptx(source, movie, cover, { duration: 15, loop: true });
  const original = await JSZip.loadAsync(source), result = await JSZip.loadAsync(output);
  for (const name of Object.keys(original.files).filter(name => !original.files[name].dir && !['ppt/presentation.xml','ppt/_rels/presentation.xml.rels','[Content_Types].xml'].includes(name) && !/^ppt\/slides\/slide\d+\.xml$/.test(name))) {
    assert.deepEqual(await result.file(name).async('nodebuffer'), await original.file(name).async('nodebuffer'), name);
  }
  for (const name of ['ppt/slides/slide1.xml','ppt/slides/slide2.xml']) {
    const before = await readXml(original, name), after = await readXml(result, name);
    assert.equal(descendants(after, NS.a, 't').map(n=>n.textContent).join(), descendants(before, NS.a, 't').map(n=>n.textContent).join());
    assert.equal(after.documentElement.getAttribute('show'), '0');
    assert.ok(descendants(after, NS.p, 'sp').length > 0);
  }
  const presentation = await readXml(result, 'ppt/presentation.xml');
  assert.equal(descendants(presentation, NS.p, 'sldId').length, 3);
  const media = Object.keys(result.files).find(name=>/motion-.*\.mp4$/.test(name));
  assert.ok(media); assert.deepEqual(await result.file(media).async('nodebuffer'), movie);
  const playback = Object.keys(result.files).find(name=>/^ppt\/slides\/motion-.*\.xml$/.test(name));
  const xml = await result.file(playback).async('string');
  assert.match(xml, /<p:video/);
  assert.match(xml, /repeatCount="indefinite"/);
  assert.match(xml, /delay="0"/);
  assert.match(xml, /<a:videoFile/);
  assert.match(xml, /<p14:media/);
  assert.match(await result.file('[Content_Types].xml').async('string'), /video\/mp4/);
});
test('movie playback keeps its 16:9 aspect ratio on standard and portrait source slides', async () => {
  const { packagePlaybackPptx } = await import('../src/cinematic.js');
  const source = await generatePptx(sourceDeck);
  for (const [width, height] of [[9144000, 6858000], [6858000, 12192000], [12192000, 6858000], [18288000, 6858000]]) {
    const zip = await JSZip.loadAsync(source);
    const presentation = await readXml(zip, 'ppt/presentation.xml');
    const size = descendants(presentation, NS.p, 'sldSz')[0];
    size.setAttribute('cx', String(width)); size.setAttribute('cy', String(height));
    zip.file('ppt/presentation.xml', new XMLSerializer().serializeToString(presentation));
    const output = await packagePlaybackPptx(await zip.generateAsync({ type: 'nodebuffer' }), Buffer.from('movie'), Buffer.from('poster'), { duration: 12 });
    const result = await JSZip.loadAsync(output);
    const name = Object.keys(result.files).find(file => /^ppt\/slides\/motion-.*\.xml$/.test(file));
    const slide = await readXml(result, name);
    const movie = descendants(slide, NS.p, 'pic')[0];
    const xfrm = descendants(movie, NS.a, 'xfrm')[0];
    const off = descendants(xfrm, NS.a, 'off')[0], ext = descendants(xfrm, NS.a, 'ext')[0];
    const x = Number(off.getAttribute('x')), y = Number(off.getAttribute('y'));
    const cx = Number(ext.getAttribute('cx')), cy = Number(ext.getAttribute('cy'));
    assert.ok(Math.abs(cx / cy - 16 / 9) < 1e-6, `${width} x ${height}: movie must not stretch`);
    assert.ok(x >= 0 && y >= 0 && x + cx <= width && y + cy <= height, 'entire movie stays on canvas');
    assert.ok(Math.abs(2 * x + cx - width) <= 1 && Math.abs(2 * y + cy - height) <= 1, 'movie is centered');
    assert.ok(cx === width || cy === height, 'movie uses all available space on one axis');
    const retained = await readXml(result, 'ppt/presentation.xml');
    assert.equal(descendants(retained, NS.p, 'sldSz')[0].getAttribute('cx'), String(width));
    assert.equal(descendants(retained, NS.p, 'sldSz')[0].getAttribute('cy'), String(height));
    assert.equal(descendants(slide, NS.p, 'bg').length, 1, 'unused space has an intentional solid background');
  }
});
test('native motion packaging creates editable Morph keyframes with timed looping', async () => {
  const { packageMorphPptx } = await import('../src/cinematic.js');
  const source = await generatePptx(sourceDeck);
  const output = await packageMorphPptx(source, { slideSeconds: 4, transitionSeconds: 1, loop: true, keyframes: 4 });
  const result = await JSZip.loadAsync(output);
  const presentation = await readXml(result, 'ppt/presentation.xml');
  const slideIds = descendants(presentation, NS.p, 'sldId');
  assert.equal(slideIds.length, 2 + 2 * 4, 'original editable pages plus four keyframes per source page');
  const presProps = await readXml(result, 'ppt/presProps.xml');
  const showPr = descendants(presProps, NS.p, 'showPr')[0];
  assert.equal(showPr?.getAttribute('loop'), '1');
  assert.equal(showPr?.getAttribute('useTimings'), '1');
  const dynamicSlides = Object.keys(result.files).filter(name => /^ppt\/slides\/morph-.*\.xml$/.test(name)).sort();
  assert.equal(dynamicSlides.length, 8);
  const morphXml = await Promise.all(dynamicSlides.map(name => result.file(name).async('string')));
  for (const name of dynamicSlides) {
    const doc = await readXml(result, name);
    assert.notEqual(doc.documentElement.getAttribute('show'), '0', 'playback keyframes must be visible');
    assert.ok(descendants(doc, NS.p, 'cNvPr').some(node => node.getAttribute('name').startsWith('!!llmpptx:')), 'Morph should explicitly match moving objects');
  }
  assert.ok(morphXml.every(xml => xml.includes('p159:morph')));
  assert.ok(morphXml.every(xml => xml.includes('Requires="p159"')));
  assert.ok(morphXml.every(xml => xml.includes('advTm="0"')));
  assert.ok(morphXml.every(xml => xml.includes('p14:dur=')));
  const p14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
  const durations = await Promise.all(dynamicSlides.slice(0, 4).map(async name => {
    const doc = await readXml(result, name);
    return Number(descendants(doc, NS.p, 'transition')[0].getAttributeNS(p14, 'dur'));
  }));
  assert.equal(durations.reduce((sum, value) => sum + value, 0), 4000, 'native transition durations sum to the requested page duration');
  assert.ok(morphXml.every(xml => /name="!!llmpptx:\d+:/.test(xml)));
  const first = await readXml(result, dynamicSlides[0]);
  const second = await readXml(result, dynamicSlides[1]);
  const transformSignature = doc => descendants(doc, NS.a, 'xfrm').map(node => {
    const off = descendants(node, NS.a, 'off')[0];
    const ext = descendants(node, NS.a, 'ext')[0];
    return [off?.getAttribute('x'), off?.getAttribute('y'), ext?.getAttribute('cx'), ext?.getAttribute('cy')].join(',');
  }).join('|');
  assert.notEqual(transformSignature(first), transformSignature(second), 'keyframes must move at least one editable object');
  for (const name of ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']) {
    const original = await readXml(result, name);
    assert.equal(original.documentElement.getAttribute('show'), '0');
    assert.ok(descendants(original, NS.a, 't').length > 0);
  }
});
test('native keyframes own their notes and link those notes back to the correct slide', async () => {
  const { packageMorphPptx } = await import('../src/cinematic.js');
  const source = await generatePptx(sourceDeck);
  const original = await JSZip.loadAsync(source);
  const zip = await JSZip.loadAsync(await packageMorphPptx(source));
  const frames = Object.keys(zip.files).filter(n => /^ppt\/slides\/morph-.*\.xml$/.test(n));
  const notes = new Set();
  for (const file of frames) {
    const rels = await readXml(zip, path.posix.join(path.posix.dirname(file), '_rels', path.posix.basename(file) + '.rels'));
    const noteRel = descendants(rels, NS.rel, 'Relationship').find(n => n.getAttribute('Type').endsWith('/notesSlide'));
    if (!noteRel) continue;
    const noteFile = path.posix.normalize(path.posix.join(path.posix.dirname(file), noteRel.getAttribute('Target')));
    assert.ok(!notes.has(noteFile), 'each keyframe should have its own notes part');
    notes.add(noteFile);
    const noteRels = await readXml(zip, path.posix.join(path.posix.dirname(noteFile), '_rels', path.posix.basename(noteFile) + '.rels'));
    const slide = descendants(noteRels, NS.rel, 'Relationship').find(n => n.getAttribute('Type').endsWith('/slide'));
    const actual = path.posix.normalize(path.posix.join(path.posix.dirname(noteFile), slide.getAttribute('Target')));
    assert.equal(actual, file, 'notes must point back to their keyframe rather than the hidden original');
  }
  assert.equal(notes.size, frames.length, 'source note pages should accompany every keyframe');
  for (const file of Object.keys(original.files).filter(n => n.startsWith('ppt/notesSlides/') && !original.files[n].dir)) {
    assert.deepEqual(await zip.file(file).async('nodebuffer'), await original.file(file).async('nodebuffer'), 'retain the original notes');
  }
});

test('native wallpaper keeps shared translucent fields behind the editable content', async () => {
  const { packageMorphPptx } = await import('../src/cinematic.js');
  const zip = await JSZip.loadAsync(await packageMorphPptx(await generatePptx(sourceDeck), { style: 'ember', motion: 'flow' }));
  const frames = Object.keys(zip.files).filter(n => /^ppt\/slides\/morph-.*\.xml$/.test(n)).sort();
  assert.equal(frames.length, 12, 'six keyframes per source scene');
  const states = [];
  for (const name of frames) {
    const doc = await readXml(zip, name);
    const objects = descendants(doc, NS.p, 'spTree')[0].childNodes;
    const names = [...objects].filter(n => n.nodeType === 1).map(n => descendants(n, NS.p, 'cNvPr')[0]?.getAttribute('name')).filter(Boolean);
    const ambient = descendants(doc, NS.p, 'grpSp').filter(n => descendants(n, NS.p, 'cNvPr')[0]?.getAttribute('name').startsWith('!!llmpptx:ambient:'));
    assert.equal(ambient.length, 3);
    assert.ok(names.slice(0, 3).every(name => name.startsWith('!!llmpptx:ambient:')), 'light fields render behind source content');
    for (const shape of ambient) {
      const alpha = descendants(shape, NS.a, 'alpha').map(n => Number(n.getAttribute('val')) / 100000);
      assert.ok(alpha.length >= 20, 'a soft field uses enough transparent steps to avoid a hard disc edge');
      assert.ok(alpha[0] <= .001, 'field edge blends into the source background');
      const opacity = 1 - alpha.reduce((remaining, value) => remaining * (1 - value), 1);
      assert.ok(opacity <= .181 && opacity >= .17, 'combined field stays translucent and readable');
    }
    states.push(ambient.map(shape => descendants(shape, NS.a, 'off').map(n => [n.getAttribute('x'), n.getAttribute('y')].join(',')).join('|')).join(';'));
  }
  assert.ok(new Set(states).size >= 6, 'fields keep moving across keyframes');
  assert.notEqual(states[0], states[1]);
  const firstNames = descendants(await readXml(zip, frames[0]), NS.p, 'cNvPr').map(n => n.getAttribute('name')).filter(n => n.startsWith('!!llmpptx:ambient:'));
  const nextNames = descendants(await readXml(zip, frames[6]), NS.p, 'cNvPr').map(n => n.getAttribute('name')).filter(n => n.startsWith('!!llmpptx:ambient:'));
  assert.deepEqual(nextNames, firstNames, 'background fields remain matched across scene boundaries');
});

test('native Morph rotates ornaments, respects intensity, and preserves body text metrics', async () => {
  const pptxgen = (await import('pptxgenjs')).default;
  const { packageMorphPptx } = await import('../src/cinematic.js');
  const deck = new pptxgen(); deck.layout = 'LAYOUT_WIDE';
  const page = deck.addSlide(); page.background = { color: '10282F' };
  page.addText('原生连续运动', { x: .8, y: 1, w: 8, h: 1, fontSize: 40, color: 'FFFFFF' });
  page.addText('这一段正文需要一直清晰可读', { x: .8, y: 3, w: 8, h: 1, fontSize: 18, color: 'FFFFFF' });
  page.addShape(deck.ShapeType.arc, { x: 9, y: 1, w: 2, h: 2, rotate: 20, line: { color: '71C6AD' }, fill: { color: '10282F', transparency: 100 } });
  const source = await deck.write({ outputType: 'nodebuffer' });
  const original = await JSZip.loadAsync(source);
  const originalDoc = await readXml(original, 'ppt/slides/slide1.xml');
  const sourceBody = descendants(originalDoc, NS.p, 'sp').find(shape => descendants(shape, NS.a, 't').some(n => n.textContent.includes('这一段')));
  const sourceBodyExt = descendants(sourceBody, NS.a, 'ext')[0];
  const outputs = [];
  for (const motion of ['flow', 'gentle']) {
    const zip = await JSZip.loadAsync(await packageMorphPptx(source, { motion, slideSeconds: 6, keyframes: 6 }));
    const frames = Object.keys(zip.files).filter(n => /^ppt\/slides\/morph-.*\.xml$/.test(n)).sort();
    const rotation = [], titles = [];
    const height = Number(descendants(await readXml(zip, 'ppt/presentation.xml'), NS.p, 'sldSz')[0].getAttribute('cy'));
    for (const [frame, name] of frames.entries()) {
      const doc = await readXml(zip, name);
      const shapes = descendants(doc, NS.p, 'sp');
      const arc = shapes.find(shape => descendants(shape, NS.a, 'prstGeom').some(n => n.getAttribute('prst') === 'arc'));
      rotation.push(Number(descendants(arc, NS.a, 'xfrm')[0].getAttribute('rot')));
      const title = shapes.find(shape => descendants(shape, NS.a, 't').some(n => n.textContent === '原生连续运动'));
      const titleOffset = descendants(title, NS.a, 'off')[0];
      if (frame === 0 || frame === frames.length - 1) {
        assert.ok(Number(titleOffset.getAttribute('y')) >= height, 'scene boundaries must clear title text before the next scene enters');
      } else titles.push(Number(titleOffset.getAttribute('x')));
      const body = shapes.find(shape => descendants(shape, NS.a, 't').some(n => n.textContent.includes('这一段')));
      const bodyExt = descendants(body, NS.a, 'ext')[0];
      assert.equal(bodyExt.getAttribute('cx'), sourceBodyExt.getAttribute('cx'), 'body wrapping width must stay constant');
      assert.equal(bodyExt.getAttribute('cy'), sourceBodyExt.getAttribute('cy'), 'body height must stay constant');
      assert.equal(descendants(body, NS.a, 'rPr')[0].getAttribute('sz'), '1800');
      assert.equal(descendants(title, NS.a, 'xfrm')[0].getAttribute('rot'), null, 'keep text upright');
      for (const transition of descendants(doc, NS.p, 'transition')) {
        assert.equal(transition.getAttribute('advTm'), '0', 'do not add a still hold between motion keyframes');
        assert.equal(transition.getAttribute('advClick'), '0');
      }
    }
    outputs.push({ rotation, titles });
  }
  const spread = list => Math.max(...list) - Math.min(...list);
  assert.ok(spread(outputs[0].rotation) > 60 * 60000, 'ornaments must visibly rotate across keyframes');
  assert.ok(spread(outputs[0].titles) > spread(outputs[1].titles) * 1.5, 'flow should move more than gentle');
});

test('continuous renderer makes moving frames, a smooth overlap, and an actual embedded movie', { timeout: 180000 }, async t => {
  const { renderCinematic } = await import('../src/cinematic.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'llm-pptx-motion-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const input = await generatePptx(sourceDeck);
  const progress=[];
  const output=await renderCinematic(input,{slideSeconds:4,transitionSeconds:1,style:'aurora',motion:'flow',loop:true}, {directory:dir,onProgress:value=>progress.push(value)});
  const probe=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-show_format','-of','json',output.videoPath])).stdout);
  const video=probe.streams.find(s=>s.codec_type==='video');
  assert.equal(video.codec_name,'h264');assert.equal(video.width,1280);assert.equal(video.height,720);
  assert.equal(video.r_frame_rate,'30/1');
  assert.ok(Math.abs(Number(probe.format.duration)-8)<0.1);
  assert.ok(progress.some(p=>p.phase==='rendering'));
  assert.equal(output.report.sourceSlides,2);assert.equal(output.report.fps,30);
  assert.ok(output.nativePptxPath, 'rendering should also produce an editable native-motion PPTX');
  const native = await JSZip.loadAsync(await fs.readFile(output.nativePptxPath));
  assert.ok(Object.keys(native.files).some(name => /^ppt\/slides\/morph-.*\.xml$/.test(name)));
  const layerReport=JSON.parse(await fs.readFile(path.join(dir,'motion.layers.json'),'utf8'));
  assert.ok(layerReport.pages.every(page=>page.foregroundAlphaFraction < 0.2), 'solid page backgrounds must be removed before content motion');
  assert.ok(layerReport.pages.every(page=>page.layerCount >= 2), 'separated slide content must be composed from multiple motion layers');
  const frame=async time=>Buffer.from((await exec('ffmpeg',['-v','error','-ss',String(time),'-i',output.videoPath,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer',maxBuffer:8*1024*1024})).stdout);
  const difference=(a,b)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=Math.abs(a[i]-b[i]);return sum/a.length;};
  const a=await frame(0.5),b=await frame(2.0);
  assert.ok(difference(a,b)>5,`scene must visibly move after entrance (pixel difference ${difference(a,b).toFixed(3)})`);
  const left=await frame(3.98),right=await frame(4.02);
  assert.ok(difference(left,right)<8,'transition midpoint must not hard cut');
  const start=await frame(0),end=await frame(8-1/30);
  assert.ok(difference(start,end)<2,'the final transition must meet the first frame without a loop flash');
  const result=await JSZip.loadAsync(await fs.readFile(output.pptxPath));
  const media=Object.keys(result.files).find(name=>name.endsWith('.mp4'));
  assert.deepEqual(await result.file(media).async('nodebuffer'),await fs.readFile(output.videoPath));
});
test('motion jobs expose progress, reject unfinished downloads, cancel and expire generated files', async t => {
  const { createMotionJobs } = await import('../src/motion-jobs.js');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'llm-pptx-job-test-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let release;
  const ready=new Promise(resolve=>{release=resolve;});
  const jobs=createMotionJobs({root:directory,ttl:50,renderer:async(buffer,settings,{directory,onProgress,signal})=>{
    onProgress({phase:'rendering',progress:42,message:'渲染中'});
    await ready;
    if(signal.aborted)throw new Error('已停止');
    const videoPath=path.join(directory,'motion.mp4');await fs.writeFile(videoPath,'movie');
    return {directory,videoPath,report:{sourceSlides:2}};
  }});
  const input=await generatePptx(sourceDeck);
  const job=await jobs.create(input,{});
  assert.ok(/^[a-f0-9-]{36}$/.test(job.id));
  assert.throws(()=>jobs.file(job.id,'video'),/完成/);
  await assert.rejects(()=>jobs.create(input,{}),/进行|等待/);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(jobs.status(job.id).progress,42);
  jobs.cancel(job.id); release();
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(jobs.status(job.id).state,'cancelled');
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(jobs.status(job.id),null);
});
test('HTTP motion workflow starts a job and serves the actual preview with range support', async t => {
  const { createMotionJobs } = await import('../src/motion-jobs.js');
  const { createApp } = await import('../src/app.js');
  const { once } = await import('node:events');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'llm-pptx-motion-http-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const jobs=createMotionJobs({root,renderer:async(buffer,settings,{directory})=>{
    const videoPath=path.join(directory,'motion.mp4'),pptxPath=path.join(directory,'motion.pptx'),nativePptxPath=path.join(directory,'native-motion.pptx'),sourcePath=path.join(directory,'source.pptx');
    await fs.writeFile(videoPath,'0123456789');await fs.writeFile(pptxPath,buffer);await fs.writeFile(nativePptxPath,buffer);await fs.writeFile(sourcePath,buffer);
    return {directory,videoPath,pptxPath,nativePptxPath,sourcePath,report:{sourceSlides:2,duration:14,nativeMotionAvailable:true}};
  }});
  const server=createApp({}, {motionJobs:jobs}).listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const form=new FormData();form.set('file',new Blob([await generatePptx(sourceDeck)]),'edited.pptx');form.set('settings',JSON.stringify({style:'silk'}));
  const response=await fetch(`${base}/api/cinematic`,{method:'POST',body:form});assert.equal(response.status,202);
  const {id}=await response.json();let job;
  for(let i=0;i<30;i++){job=await(await fetch(`${base}/api/cinematic/${id}`)).json();if(job.state==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(job.state,'completed');assert.equal(job.report.sourceSlides,2);
  assert.ok(!JSON.stringify(job).includes(root));
  const movie=await fetch(`${base}/api/cinematic/${id}/video.mp4`,{headers:{range:'bytes=2-5'}});
  assert.equal(movie.status,206);assert.equal(await movie.text(),'2345');
  const pptx=await fetch(`${base}/api/cinematic/${id}/presentation.pptx`);assert.equal(pptx.status,200);assert.match(pptx.headers.get('content-disposition'),/attachment/);
  const native=await fetch(`${base}/api/cinematic/${id}/native-motion.pptx`);assert.equal(native.status,200);assert.match(native.headers.get('content-disposition'),/attachment/);
  assert.equal((await fetch(`${base}/api/cinematic/missing`)).status,404);
});
