# 开源来源与许可

本项目采用组合开源组件的方式构建两阶段工作流。静态 PPTX 导出直接使用 **PptxGenJS 4.0.1**，动画加工模块和网页工作台为本仓库新增实现。本轮直接纳入 ppt-master 的 6 个 MIT 版式 SVG 与设计说明，提取几何数据用于原生布局。没有复制 Presenton、PPTist 或 Slidev 的实现代码。

| 组件 | 用途 | 许可证 | 上游 |
| --- | --- | --- | --- |
| ppt-master / presentation_core | 部分版式源码、坐标与原生版式参考 | MIT | https://github.com/hugohe3/ppt-master/tree/b113d23720260c411ee47b2b05a73615f954deeb |
| PptxGenJS 4.0.1 | 原生可编辑 PPTX 生成 | MIT | https://github.com/gitbrent/PptxGenJS |
| JSZip 3.10.1 | PPTX/DOCX 文件包读取与保存 | MIT / GPL-3.0，按 MIT 使用 | https://github.com/Stuk/jszip |
| @xmldom/xmldom 0.9.12 | 按命名空间读取与修改 XML | MIT | https://github.com/xmldom/xmldom |
| pdf-parse 2.4.5 | 提取 PDF 文字 | Apache-2.0 | https://github.com/mehmet-kozan/pdf-parse |
| Express 5.1.0 | 本地 HTTP 服务 | MIT | https://github.com/expressjs/express |
| Multer 2.4.0 | 内存文件上传 | MIT | https://github.com/expressjs/multer |
| Zod 4.1.12 | 输入和模型输出校验 | MIT | https://github.com/colinhacks/zod |

PptxGenJS 的完整 MIT 声明保存在 `licenses/PptxGenJS.MIT.txt`。其他依赖随 npm 包保留自己的 LICENSE / NOTICE；分发包含依赖的版本时需一起保留。具体版本和依赖完整性由 `package-lock.json` 锁定。

`image-size` 通过 npm overrides 固定到 2.0.4，避免安装 PptxGenJS 默认依赖范围中有已知漏洞的版本。原生图片和表格的回归测试覆盖了相关生成路径。使用 `npm audit --omit=dev` 复查依赖状态。

以上是第三方组件的许可说明，本文件不为仓库新增代码指定整体开源许可证。

`third_party/ppt-master/LICENSE` 保留 Hugo He 的完整 MIT 声明，原样源模板放在相邻目录；派生几何数据位于 `public/core-templates.js`，可通过 `scripts/import-core-templates.js` 重新生成。选择依据、固定版本和实际使用范围见 `docs/open-source-design.md`。
