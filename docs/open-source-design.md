# 静态 PPT 开源项目调研与集成

调研日期：2026-10-18。Star 数为当天 GitHub API 快照，持续变化。

| 项目 | Star 快照 | 许可证 | 判断 |
| --- | ---: | --- | --- |
| [ppt-master](https://github.com/hugohe3/ppt-master) | 63,122 | MIT | 直接集成选定原生版式的坐标数据，保留许可证 |
| [Slidev](https://github.com/slidevjs/slidev) | 49,101 | MIT | 默认 PPTX 为逐页图片；当前也有 editable 导出，但允许逐页图片回退，不作为主链路 |
| [Presenton](https://github.com/presenton/presenton) | 11,171 | Apache-2.0 | 参考结构化字段到模板的组织方式，没有复制代码；其模板创建图像链路不进入本项目 |
| [PPTist](https://github.com/pipipi-pikachu/PPTist) | 9,404 | AGPL-3.0 | 是完整在线编辑器，本轮不引入整套编辑器与相应部署范围 |
| [PptxGenJS](https://github.com/gitbrent/PptxGenJS) | 6,280 | MIT | 继续负责可编辑文本和图形写入；仅使用导出库不能解决版式单一问题 |

## 实际集成内容

ppt-master 固定提交：`b113d23720260c411ee47b2b05a73615f954deeb`。

从 `skills/ppt-master/templates/layouts/presentation_core/templates/` 纳入 6 个 SVG 源模板与 `design_spec.md`，位于 `third_party/ppt-master/presentation_core/`，原许可证在 `third_party/ppt-master/LICENSE`。选定模板为封面、对比、编辑分栏、三卡片、指标看板、流程时间线。它们作为源码和可追溯参考，不作为整页图片放入 PPTX。

`npm run templates:compile` 只解析 SVG 中的占位框和面板坐标，生成 `public/core-templates.js`。`public/layout.js` 使用其中的封面占位区、分栏支撑区、卡片和对比面板起点；同时按实际中文容量和内容数量计算页面，新增适配的流程与指标排版。不是把上游全部功能接入，也不依赖上游 Python、图片生成或视觉验证链路。

- 封面：大标题、短副标题和留白。
- 分栏：左侧核心结论，右侧分层说明；长材料回到完整正文行。
- 卡片：观点与说明分开，2–4 项优先，密集内容保留原文并使用全文宽行。
- 对比：左右区域独立组织，按内容自动适配行列。
- 流程：短内容使用水平节点与连接线；较长内容改为纵向步骤。
- 数字重点：只显示材料明确提供的值、名称和口径说明，不编造图表数据。
- 观点大字与总结：适应短结论和行动事项。

所有生成内容都通过 PptxGenJS 写成独立的原生文字和形状，包括流程节点与连接线。眉题、页码与分隔线保持静态装饰；观点标题、正文、面板和对应标记保留稳定分组，供动画加工使用。

## 成本和边界

模型只输出内容和版式语义。坐标、字号、估算容量、文件写入、动画时间轴由本机程序完成；动画优化只发送当前页必要摘要。内置版式示例无须调用模型。

没有截图或调用视觉模型；未通过图片检查版式。几何与文件结构测试无法证明主观美观、中文字体在两种软件中的实际排版或播放流畅度；需要用户在 PowerPoint/WPS 中放映确认。当前未宣称两种软件已通过播放验收。
