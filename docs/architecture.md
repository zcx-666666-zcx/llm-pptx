# 两阶段原生演示流程

## 内容与静态布局

`src/outline.js` 约束可编辑内容模型。`slideCount` 可选，指定时校验总页数（包括封面），省略时由模型决定；无模型的原文分页保持原文，不丢弃材料匹配页数。AI 使用现有 `src/llm.js` 流式协议和完成校验。

`public/layout.js` 是服务端与网页共用的纯几何模块。输入 layout、title、subtitle、bullets 或结构化 items（heading/body/value）、eyebrow 与 takeaway，输出文字/图形的坐标、字体、语义角色和分组。通过 `core-templates.js` 接入 ppt-master 的部分 MIT 版式坐标，提供封面、章节、分栏、卡片、对比、流程、数字重点、观点大字、总结。横向流程按节点讲解，长说明回到纵向步骤，正文较多时卡片改用宽行，无法容纳则拒绝导出。校验有限坐标、画布边界、文本框重叠和估算字体容量，不依赖图像。

`src/presentation.js` 通过已有 PptxGenJS 输出原生文本框与图形，再将稳定对象标识、角色、分组写入 cNvPr 的 descr，布局写入 cSld 的 name。用户改名、调整页序后仍可识别；不要求用户保留元数据，没有元数据时根据实际文字和几何保守识别。

## 上传与动画计划

`src/animation.js` 按 presentation.xml 关系顺序读取实际页，保留兼容性分支。以顶层组为整体，不拆内部几何。识别标题、正文、图片、生成器的语义组，图表/表格/嵌入媒体和位置不明对象保留静态并提示。

`planAnimations(buffer)` 返回 version、文件指纹、页面尺寸和逐页方案：页面指纹、layout、policy、transition、transitionDuration、steps、objects、warnings。每个 step 含 id、label、targets、trigger(auto/click)、effect、duration。普通页自动，流程与对比页主体点击，已有动画 preserve，隐藏页 skip。

`refineAnimationPage` 仅对请求页发送文字片段、对象 id、位置、分组、类型和当前步骤，不发送整个 PPTX、其他页面、备注或媒体。模型流式返回 steps，复用同一份 ID/时长/目标校验。不自动反复修复模型响应，失败保留原方案。

`public/steps.js` 的排序、合并、拆分和紧凑请求序列化都是本地操作。前端展示步骤与停顿点，按需调用 AI，允许手动恢复静态对象。

## 时间轴与保真

`applyAnimationPlan` 先检查文件与页面指纹及所有目标 ID。一个 click 步骤开始一个等待点击的分组，后续 auto 步骤在该分组内按时长依次推进。同一步的多个对象共用开始偏移。入口使用原生 p:animEffect；轻移入场增加小幅相对路径且最后回到原坐标；强调使用返回原值的透明度脉冲。已有时间轴默认保留，只有显式 replaceExisting 才重建。

不生成视频，不新增或隐藏关键帧页，不修改 cSld 中的文字、位置、图片与图形。页面切换关闭 advTm、开启 advClick；放映属性关闭循环、计时和 kiosk，显式启用 showAnimation。已保留页面的原对象动画不重写。

下载前重新读取输出，比较页数、页序、完整内容树、部件清单与未修改部件字节，检查时间轴编号、目标引用、兼容扩展节点顺序、放映动画开关和所有内部关系。报告单独保留 powerPointPlaybackValidated=false 与 wpsPlaybackValidated=false，避免将结构校验当作实际播放证明。

## 范围与验证边界

原生主流程仅依赖 Node.js。历史 cinematic 模块和接口留作兼容实验，不在网页主流程中使用，默认检查也不运行其渲染工具；历史实验测试需显式运行 `npm run test:legacy-cinematic`。PDF-to-PPTX 插件不参与。

默认采用原生基础效果与淡化转场作为兼容候选，不声称两种软件已实测一致。整个开发与自动校验不截图、不调用视觉模型。用户在两种演示软件中分别放映后，以实际问题决定简化效果。
