# llm-pptx

输入主题或长文本，生成可编辑的静态 PPTX。在 PowerPoint 或 WPS 中微调、保存并重新上传，再编排随讲解推进的原生动画，下载一个动态 PPTX。

## 运行

需要 Node.js 22.16 或更高版本。

```bash
npm ci
npm start
```

打开 http://127.0.0.1:3210。默认只监听本机。正常生成、导入和动画加工在内存中完成，刷新网页会清空草稿和上传状态。支持提取 TXT、Markdown、DOCX、含文字的 PDF；扫描 PDF 需要先 OCR。PDF 转换插件不参与此流程。

## 静态生成与人工微调

- 输入一个主题、一大段材料，或导入文档。有模型配置时默认使用流式 AI 编排，无配置时仍可按原文分页。
- 页数可留空，由 AI 根据内容决定（1–30 页）；指定页数包含封面，模型输出不符时明确报错，不删页凑数。原文分页按标题组织，指定页数与实际不同也会提示改用 AI 或调整章节。
- AI 在封面、章节、分栏解释、观点卡片、双栏对比、流程时间线、数字重点、观点大字、总结布局间选择。观点标题、说明、原有数值与结论独立组织；网页支持逐页编辑、添加和删除观点。
- 静态布局直接参考并集成高 star 的 [ppt-master](https://github.com/hugohe3/ppt-master) MIT 版式几何，不依赖截图。调研、固定版本、许可和集成范围见 [开源设计记录](docs/open-source-design.md)。网页“查看版式示例”可直接查看与下载 8 页示例，无须调用模型。
- 网页预览与 PPTX 导出使用同一套坐标计算。文字、图形保持独立可编辑。生成时检查画布边界、文本框重叠和估算文字容量，正文不缩到 17pt 以下；无法容纳时明确提示。
- 下载静态 PPTX，用 PowerPoint 或 WPS 修改文字、图片、对象位置、页序，然后另存为新文件并上传第二阶段。

文档导入当前提取文字，不自动迁移源文档图片。用户在 PPTX 中添加的图片、图表、表格和备注会在动画加工时保留。文字容量属于几何估算，不等于实际字体排版的视觉验收。

## 动画加工

上传微调后的标准 PPTX（最多 30 MB、200 页）。系统读取实际页序、对象、位置、分组与已有动画，生成可编辑的逐页步骤。

- 普通页自动完成简短入场，随后停留。流程与对比页标题自动入场，主体内容按点击分组展开。每页结束后仍由演讲者点击翻页。
- 一步可包含多个对象，如同一个流程节点的编号、标记、正文与连接线。可上移、下移、合并、拆分步骤，修改开始方式、效果、时长，或将对象保持静态。
- 可选淡入、轻移淡入、向上展开、柔和强调和直接出现。时长 200–1800 毫秒，页间默认柔和淡化。没有定时翻页、循环壁纸、影片嵌入或多张关键帧扩页。
- 默认保留已有动画。需要重建时在对应页明确勾选；未知用途的图形、复杂图表/表格、继承位置不明的对象保留静态并说明原因。隐藏页保留。
- “AI 优化本页”是可选操作，仅发送当前页必要的对象文字摘要、坐标、分组和现有步骤，流式返回经过校验的方案。其他页不重生成。取消、断流或无效对象引用不会覆盖原方案。
- 输出检查原始页数、顺序、内容树、布局、对象引用和内部关系。媒体、备注、母版及其他部件保留。只有页面动画/切换和放映属性按需修改；原文件不覆盖。

目标是同一个文件在 PowerPoint 与 WPS 中使用。选用原生基础效果而不依赖 Morph；两种软件的实际播放一致性仍需分别放映确认，发现不一致的效果应简化或移除。网页提供对象和步骤信息，不模拟播放结果，也不会截图或调用视觉模型。

## 模型与流式输出

当前项目 `.env` 继续使用已接入的 Codex 对应服务配置。密钥保留本机，不进入浏览器和日志，不修改 CC Switch 或 Codex 的配置。更换提供商或模型后需同步项目 `.env` 并重启。

```dotenv
LLM_BASE_URL=https://your-provider.example/v1
LLM_MODEL=your-model-name
LLM_API_KEY=your-api-key
LLM_WIRE_API=responses
LLM_REASONING_EFFORT=high
```

支持 Responses 和 Chat Completions 兼容接口。AI 内容编排与可选的逐页动画优化都使用 SSE，完成事件和结构校验通过后才更新草稿；不静默降级，不自动重试消耗额度。无需模型的布局、坐标计算、默认动画建议、步骤修改与文件校验由程序完成。

## 接口

| 接口 | 用途 |
| --- | --- |
| `POST /api/documents` | multipart `file`，提取文字 |
| `POST /api/plan/stream` | JSON `text, mode, title?, slideCount?`，SSE 返回内容编排 |
| `POST /api/plan` | 同上，JSON 响应 |
| `POST /api/export` | JSON `deck, theme`，下载静态 PPTX |
| `POST /api/animation-plan` | multipart `file`，读取上传文件并返回逐页方案 |
| `POST /api/animation-plan/stream` | multipart `file, settings`，`settings={number,page}`，SSE 优化指定页 |
| `POST /api/animate-native` | multipart `file, plan`，下载原生动态 PPTX；`X-Animation-Report` 返回结构检查摘要 |

方案带文件和页面指纹，防止把旧对象编号用于新文件。步骤使用实际原生对象 ID。前端导出只传必要字段，不回传冗余对象摘要。旧 `/api/inspect`、`/api/animate` 及历史影片实验代码仅保留兼容，工作台不调用影片接口，原生流程不需要 LibreOffice、FFmpeg 或图像处理库。

## 验证

```bash
npm run check
npm run demo:presenter
npm run demo:design
```

`demo:design` 生成 8 页新设计在三个主题下的静态文件，以及原生动画文件、方案、校验记录和放映说明。`npm run templates:compile` 可从保留的上游 SVG 重新编译几何数据。

`demo:presenter` 在 `artifacts/presenter-*` 新目录生成六种布局的静态 PPTX、一个原生动态 PPTX、逐页方案、SHA-256 与结构验证记录、简短放映说明。每次独立保存，不覆盖人工记录。

测试覆盖可选和严格页数、多种布局及几何容量、流式协议和取消、上传导出、人工增删/重命名对象、原始内容与媒体保留、步骤组合、已有动画保护、手动翻页及损坏引用。模型夹具测试不代表真实模型内容质量。结构检查不代表 PowerPoint 或 WPS 的实际放映验收。

本次实施不截图，不生成检查图片，不使用视觉模型。人工放映只需记录软件版本、问题页码、操作及具体表现。

本次真实模型、网页操作与结构验收记录见 [docs/verification-2026-10-18.md](docs/verification-2026-10-18.md)。

新版示例文件：[静态 PPTX](examples/design-v2/static.pptx)、[动态 PPTX](examples/design-v2/animated.pptx)。本次升级验证记录见 [docs/static-design-verification-2026-10-18.md](docs/static-design-verification-2026-10-18.md)。

默认 `npm test` / `npm run check` 仅验证当前原生 PPTX 流程及相关兼容接口。旧影片实验测试单独保留为 `npm run test:legacy-cinematic`，不参与正常生成和默认验证。
