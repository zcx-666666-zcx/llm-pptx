import fs from 'node:fs/promises';
import path from 'node:path';
import pptxgen from 'pptxgenjs';
import { renderCinematic } from '../src/cinematic.js';
const directory = path.resolve('artifacts/continuous-demo');
await fs.mkdir(directory, { recursive: true });
const deck = new pptxgen(); deck.layout = 'LAYOUT_WIDE'; deck.author = 'llm-pptx'; deck.title = '连续动态演示'; deck.subject = '流动背景与平滑转场'; deck.lang = 'zh-CN';
const colors = { bg: '10282F', text: 'F2F4EA', muted: 'BCD5CF', teal: '71C6AD', gold: 'E4C28D' };
const scenes = [
  ['流动的背景', '像动态壁纸一样，画面始终在呼吸', '持续的光影变化', '内容停留时，背景也在缓慢流动。'],
  ['连续的镜头', '保留你调整好的版式，让画面缓缓展开', '温和的画面运动', '原页面作为画面来源，不重新排版文字和图片。'],
  ['平滑的转场', '从这一页，优雅地走向下一页', '完整的一段演示', '页与页柔和衔接，自动播放，也可以循环。'],
];
for (let i=0;i<scenes.length;i++) {
  const [title, subtitle, label, body] = scenes[i];
  const slide = deck.addSlide(); slide.background = {color:colors.bg};
  slide.addText(title,{x:.85,y:1.0,w:8.9,h:1.05,fontFace:'Microsoft YaHei',fontSize:44,bold:true,color:colors.text,margin:0,breakLine:false});
  slide.addText(subtitle,{x:.9,y:2.32,w:9.1,h:.55,fontFace:'Microsoft YaHei',fontSize:20,color:colors.muted,margin:0});
  slide.addText(label,{x:.9,y:4.9,w:8.4,h:.45,fontFace:'Microsoft YaHei',fontSize:18,color:colors.teal,margin:0});
  slide.addText(body,{x:.9,y:5.5,w:10.9,h:.68,fontFace:'Microsoft YaHei',fontSize:15,color:colors.muted,margin:0});
  for(let r=0;r<3;r++) slide.addShape(deck.ShapeType.arc,{x:9.0+r*.34,y:1.1+r*.45,w:2.1,h:2.1,adjustPoint:.2,rotate:i*26+r*40,line:{color:r===1?colors.gold:colors.teal,width:1.5,transparency:r*17},fill:{color:colors.bg,transparency:100}});
  slide.addShape(deck.ShapeType.line,{x:.9,y:4.45,w:11.25,h:0,line:{color:colors.muted,width:.7,transparency:72}});
}
const buffer=await deck.write({outputType:'nodebuffer'});
await fs.writeFile(path.join(directory,'original-editable.pptx'),buffer);
const result=await renderCinematic(buffer,{style:'aurora',slideSeconds:6,transitionSeconds:1.6,motion:'flow',loop:true},{directory,onProgress:p=>console.log(JSON.stringify(p))});
console.log(JSON.stringify({video:result.videoPath,presentation:result.pptxPath,...result.report}));
