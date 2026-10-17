import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
export const NS = { p: 'http://schemas.openxmlformats.org/presentationml/2006/main', a: 'http://schemas.openxmlformats.org/drawingml/2006/main', r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', rel: 'http://schemas.openxmlformats.org/package/2006/relationships' };
export const elements = node => [...node.childNodes].filter(n => n.nodeType === 1);
export const descendants = (node, ns, name) => [...node.getElementsByTagNameNS(ns, name)];
export const serialize = node => new XMLSerializer().serializeToString(node);
export function parseXml(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML 不允许包含实体或文档类型声明');
  const errors = [];
  const doc = new DOMParser({ onError: (level, message) => { errors.push(message); } }).parseFromString(xml, 'application/xml');
  if (errors.length || !doc.documentElement) throw new Error('XML 格式损坏');
  return doc;
}
export async function loadPackage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 30 * 1024 * 1024) throw new Error('文件大小不能超过 30 MB');
  let zip;
  try { zip = await JSZip.loadAsync(buffer, { checkCRC32: false }); }
  catch { throw new Error('无法读取 ZIP/PPTX 文件，请检查文件是否完整或被加密'); }
  const entries = Object.values(zip.files).filter(f => !f.dir);
  const total = entries.reduce((sum, f) => sum + (f._data?.uncompressedSize ?? 0), 0);
  if (entries.length > 12000 || total > 200 * 1024 * 1024) throw new Error('解压后文件过大');
  return zip;
}
export async function readXml(zip, path) {
  const file = zip.file(path);
  if (!file) throw new Error(`PPTX/DOCX 缺少文件部件：${path}`);
  const xml = await file.async('string');
  if (xml.length > 12 * 1024 * 1024) throw new Error('XML 部件过大');
  return parseXml(xml);
}
