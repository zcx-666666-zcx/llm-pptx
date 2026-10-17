import PptxGenJS from 'pptxgenjs';
import { validateDeck } from './outline.js';
import { layoutSlide, themes } from '../public/layout.js';
import { loadPackage, readXml, serialize, descendants, NS } from './package.js';
export { themes } from '../public/layout.js';
export async function generatePptx(input, { theme = 'studio' } = {}) {
  const deck = validateDeck(input), colors = themes[theme];
  if (!colors) throw new Error('未知演示主题');
  const pptx = new PptxGenJS(), metadata = [];
  pptx.layout = 'LAYOUT_WIDE'; pptx.author = 'llm-pptx'; pptx.subject = '可编辑的静态演示文稿'; pptx.title = deck.title; pptx.lang = 'zh-CN';
  pptx.theme = { headFontFace: colors.font, bodyFontFace: colors.font, lang: 'zh-CN' };
  deck.slides.forEach((data, index) => {
    const slide = pptx.addSlide(); slide.background = { color: colors.bg };
    const objects = layoutSlide(data, index + 1); metadata.push(objects);
    for (const o of objects) {
      const objectName = o.role === 'decoration' ? `llmpptx:decor:${o.key}` : o.key === 'title' ? '标题' : o.key === 'subtitle' ? '副标题' : o.key.startsWith('body-') ? `正文 ${o.key.slice(5)}` : o.key;
      if (o.kind === 'text') slide.addText(o.text, { x: o.x, y: o.y, w: o.w, h: o.h, fontFace: colors.font, fontSize: o.size, color: colors[o.color], bold: o.bold, margin: 0, valign: o.valign || 'top', align: o.align || 'left', lineSpacingMultiple: 1.15, breakLine: false, objectName });
      else slide.addShape(pptx.ShapeType[o.kind] || pptx.ShapeType.rect, { x: o.x, y: o.y, w: o.w, h: o.h, fill: { color: colors[o.color] }, line: { color: colors[o.color], transparency: 100 }, objectName });
    }
    if (data.notes) slide.addNotes(data.notes);
  });
  const zip = await loadPackage(Buffer.from(await pptx.write({ outputType: 'nodebuffer', compression: true })));
  for (let i = 0; i < metadata.length; i++) {
    const file = `ppt/slides/slide${i + 1}.xml`, doc = await readXml(zip, file);
    descendants(doc, NS.p, 'cSld')[0].setAttribute('name', `llmpptx:layout:${deck.slides[i].layout}`);
    const props = descendants(doc, NS.p, 'cNvPr').slice(1);
    metadata[i].forEach((o, j) => props[j].setAttribute('descr', JSON.stringify({ stableId: `s${i + 1}-${o.key}`, role: o.role, group: o.group, layout: deck.slides[i].layout })));
    zip.file(file, serialize(doc));
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
