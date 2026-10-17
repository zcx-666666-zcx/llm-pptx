import { extname } from 'node:path';
import { loadPackage, readXml, descendants } from './package.js';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export async function extractDocument(buffer, filename) {
  const ext = extname(filename).toLowerCase();
  let text;
  if (['.txt', '.md'].includes(ext)) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, ''); }
    catch { throw new Error('文本编码不是 UTF-8，请另存为 UTF-8 后上传'); }
  } else if (ext === '.docx') {
    const doc = await readXml(await loadPackage(buffer), 'word/document.xml');
    text = descendants(doc, W, 'p').map(p => descendants(p, W, '*').map(n => n.localName === 't' ? n.textContent : ['tab', 'br', 'cr'].includes(n.localName) ? ' ' : '').join('')).join('\n');
  } else if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try { text = (await parser.getText({ pageJoiner: '' })).text; }
    catch { throw new Error('PDF 读取失败，请检查是否加密或损坏'); }
    finally { await parser.destroy(); }
  } else throw new Error('支持 TXT、Markdown、DOCX 和含文字的 PDF');
  text = text.trim();
  if (!text) throw new Error('文档中没有可读取的文字内容；扫描 PDF 需要先做 OCR');
  if (text.length > 100000) throw new Error('文档文字超过 100000 字符，请分段上传');
  return text;
}
