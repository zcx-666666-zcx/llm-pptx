# 验收记录：2026-10-17

环境：macOS、本地 Node.js 22.22.2。日期使用 Asia/Shanghai。

## 需求与证据

| 需求 | 已取得证据 | 判断 |
| --- | --- | --- |
| 使用开源基础 | `package-lock.json` 锁定 PptxGenJS 4.0.1，静态导出实际调用其 API；保留 MIT 声明 | 已实现 |
| 文本或文档输入 | UTF-8 文本、Markdown、DOCX 段落、有效文本 PDF 的自动测试；浏览器示例输入实测 | 已实现文字提取；扫描 OCR、文档图片和复杂原版式未实现 |
| AI 内容编排 | 提纲 JSON 校验、错误不降级、服务端密钥隔离；本地测试提供商通过实际 HTTP 请求验证协议 | 已按用户授权接入当前 Codex 模型；流式协议与错误处理已验证，真实整份 PPT 生成结果见文末最新记录 |
| 静态 PPTX 可编辑 | ZIP 内为原生 `p:sp`/`a:t`，中文、正文和讲稿可读取；四页示例经 LibreOffice 读取并导出 PDF | 已验证示例；未在 Microsoft PowerPoint 内交互编辑 |
| 人工调整后导入 | 自动测试人工追加对象、修改文字、调整页序，浏览器逐页修改后的下载文件再次导入 | 已验证结构与网页编辑后的交接；没有用户本人实际修改的文件 |
| 动画保留原内容和排版 | `cSld` 序列化前后相同，所有非目标 ZIP 部件内容逐项相同；媒体、表格、备注夹具保留 | 已验证测试样本，不等于任意第三方文件完全兼容 |
| 原生动画输出 | 默认生成 `p:timing`、主序列和原生入场；LibreOffice 读取后导出的 FODP 含 `ooo-entrance-fade-in`，区分 `on-click` / `after-previous`；另存 PPTX 后效果保留 | 有跨应用解析证据；PowerPoint 放映未实测 |
| 两阶段网页 | Ego 浏览器实际点击生成、编辑、下载静态、重新上传、自动动画下载；修改文字在最终 XML 中仍存在 | 已验证 |
| 移动端布局 | 390×844 视口，页面宽 390，无元素超出视口右侧 | 已验证当前页面 |

## 自动检查

执行：

```bash
npm run check
npm audit --omit=dev
npm run demo
```

检查覆盖文档、结构化编排、模型兼容接口、可编辑导出、重新上传、内容保留、真实页序、原生图片/表格/备注、对象选择、已有动画、坏 ZIP/XML、对象 ID、PDF 提取器的多余页码和中文下载文件名。前一轮复核为 36 项测试全部通过，`npm audit --omit=dev` 报告 0 个漏洞。

新增功能使用先失败、后实现的测试顺序。修复 PDF 提取器页码和 multipart 中文文件名时均先复现了失败。测试模型是本地夹具，密钥为测试字符串。

PptxGenJS 4.0.1 在“文字 + 图片 + 表格”的组合测试中产生了重复对象 ID。为了验证合法外部 PPTX 的处理，测试夹具显式修正了表格 ID。生产导入器遇到重复 ID 会拒绝处理并提示重新保存，不会向多个同号对象盲目添加动画。当前静态生成器仅生成文本和页脚，没有调用这个表格编号路径。

## 办公软件读取与视觉检查

`npm run demo` 生成四页静态、逐个单击淡入、依次自动淡入三份示例。通过独立 LibreOffice 配置目录导出 PDF，并将两份动画文件另存为 PPTX 和 FODP。

```bash
soffice --headless -env:UserInstallation=file:///tmp/llm-pptx-office-qa \
  --convert-to pdf --outdir artifacts/rendered artifacts/demo-static.pptx \
  artifacts/demo-animated.pptx artifacts/demo-automatic.pptx

soffice --headless -env:UserInstallation=file:///tmp/llm-pptx-office-qa \
  --convert-to fodp --outdir artifacts/roundtrip \
  artifacts/demo-animated.pptx artifacts/demo-automatic.pptx
```

当前自带的 headless LibreOffice 使用独立字体目录，初次 PDF 渲染缺少中文。对验证进程设置临时 FONTCONFIG_FILE，指向 macOS 已安装的中文字体后，中文正常显示。未更改系统字体，也未将系统字体复制进仓库。

三份最终 PDF 均为四页。以 PyMuPDF 渲染各页，静态、单击、自动版本每一页的像素 SHA-256 均相同，提取的中文正文完整。检查了四页拼图及第二页的放大图，未见截断或对象重叠。这个结果仅说明示例的最终画面一致，不说明动画的逐帧视觉效果已经验收。

LibreOffice FODP 中可识别 13 个原生淡入对象效果，附加 4 个页面淡化转换。每个淡入对象效果时长为 0.5 秒。单击版识别 `on-click`，自动版识别 `after-previous`。动画文件在 LibreOffice 另存后的第二页仍有 4 个 `p:animEffect`。

## 本地验收产物

以下文件位于被 Git 忽略的 `artifacts/`，不上传用户材料：

- `demo-static.pptx`、`demo-animated.pptx`、`demo-automatic.pptx`
- `demo-report.json`、`office-verification.json`
- `rendered-cjk/`：有中文字体的 PDF
- `roundtrip/`：LibreOffice 重新保存的 PPTX 和 FODP
- `deck-contact.png`、`slide-2-cjk.png`：视觉检查
- `browser-static.pptx`、`browser-animated.pptx`：浏览器实际下载产物
- `ui-desktop.png`、`ui-mobile-motion.png`：工作台截图

## 尚未验收

- 用户选择的真实模型与实际文档内容生成质量。
- Microsoft PowerPoint 实际打开、编辑、保存和放映后的效果时序。
- 用户常用的复杂母版、SmartArt、媒体、触发器和字体环境。

目前证据能支持“本地实现和测试样本跑通”，不能据此声称 PowerPoint 全格式兼容或真实用户工作流已经全部验收。

## 审查后的回归

独立代码审查确认并复现了兼容性载体内时间轴漏判、互斥对象表示误判/漏选、多行正文框高度不足三类问题。增加失败用例后修复：

- 识别直接时间轴和 `mc:AlternateContent` 中的时间轴/切换，默认保留原页；显式替换纯时间轴载体时不追加重复节点。
- 对只读对象树克隆展开兼容性分支，互斥表示内的同编号不再误判为重复；原始页面对象树保持不变。分支对象编号不一致、或载体混合其他内容时明确拒绝危险操作。
- 根据显式换行与中西文宽度估算正文所需高度，动态选择 22–17pt 字号。无法容纳的页面明确拒绝导出。八行正文与下一条正文的回归样本已导出 PDF 并目视确认没有相互重叠。
- 单独将“出现”效果导入 LibreOffice，FODP 中识别出 13 个 `ooo-entrance-appear` 效果。

审查后重新生成四页示例，三种版本的逐页渲染像素仍全部一致。浏览器再次实测“出现 + 自动”下载；不相关的效果时长/间隔输入会随选项禁用。

追加复核修正了嵌套兼容性表示的编号比较顺序，以及根级兼容性扩展列表的时间轴插入锚点；对应失败用例修复后通过。纯扩展载体被作为完整插入锚点，混合内容载体仍明确拒绝危险改写。

## 原文保留与验收包补充

在继续核对时复现了两项原文分页缺陷，并先补失败用例再修复：连续或末尾没有正文的章节标题被丢失，以及较多 emoji / 扩展汉字因长度计算与校验单位不同而无法导出。现在无正文的章节会保留为独立的可编辑页面；分页按完整 Unicode 码点迭代，同时遵循 UTF-16 长度预算。测试还覆盖修复后的静态导出和动画转换，以及完整章节后不额外添加空白续页。

新增 `npm run acceptance`，生成独立目录的四份 PPTX、文件指纹、操作清单和人工验收记录。测试核对实际文件的 SHA-256、字节数、页数、对象数、动画存在情况，以及非目标 ZIP 部件保留。重复生成不会覆盖既有人工记录。样本包始终明确标记真实模型、PowerPoint 打开/编辑/放映为“待验收”。

接入模型前的检查结果：本机项目尚无 .env，工作台 /api/config 返回 aiConfigured:false；默认 Ollama 与 LM Studio 端点未返回可用服务，标准应用路径下未发现 Microsoft PowerPoint。这些是当前真实验收的外部条件，不能用夹具响应或 LibreOffice 解析替代。

本轮最终 `npm run check` 为 42 项全部通过，依赖审计为 0 个已知漏洞。重启当前本地服务后，以真实 HTTP 请求复核了无正文章节、末尾章节与 Unicode 内容的四页静态导出和动画转换，四页全部处理成功；这项复核未调用真实模型或 PowerPoint。

## 接入模型前的外部阻塞复核（历史记录）

连续三轮目标推进均未取得真实模型配置与 PowerPoint 环境。本次只读复核确认：项目不存在 .env，LLM_BASE_URL / LLM_MODEL / LLM_API_KEY 均未设置；运行中的工作台 /api/config 正常返回 HTTP 200，但 aiConfigured 为 false。标准安装路径未找到 PowerPoint。验收包 manifest 仍保留 aiProviderValidated:false、powerPointPlaybackValidated:false，所有人工检查均为 pending。

目标在此处标记为外部条件阻塞，已有实现和待验收样本包保持可用。恢复所需输入：用户选用的模型服务地址、模型名（密钥仅填写本地 .env），以及使用 PowerPoint 完成样本编辑与放映后的验收证据。用户若明确调整验收环境或范围，应按新的要求重新审视这些条件。


## 复用当前 Codex 模型与流式输出（最新记录）

用户明确授权从 CC Switch 查找当前 Codex 模型配置，并要求流式输出。现场核对发现，Codex 当前生效模型为 `gpt-6.1-sol`，自定义提供商使用 Responses 协议与 `high` 推理强度；CC Switch 保存的当前预设中模型名仍为 `gpt-6-luna`。本项目以 Codex 当前生效配置为准，未更换提供商或模型。

凭据从当前提供商配置复制到项目 `.env`，权限为 `600`，`git check-ignore .env` 确认被忽略。原 Codex 和 CC Switch 配置均未修改。重启后 `/api/config` 返回 `aiConfigured:true`、`model:gpt-6.1-sol`、`wireApi:responses`、`streaming:true`，浏览器接口不含密钥。

实现新增 Responses 与 Chat Completions 流式接收、SSE 转发、UTF-8 分块解码、完整页面增量预览、完成事件校验和用户取消。前端只在完整结果通过提纲校验后允许编辑与导出，服务失败不会变成离线生成结果。浏览器实测停止生成后恢复操作，下载按钮保持禁用；重新生成时会清除上一条提示，避免旧错误覆盖当前进度。390px 视口下页面宽度为 390px，无横向溢出。

本次 `npm run check` 为 51 项通过，`npm audit --omit=dev` 为 0 个已知漏洞。新增测试包含尚未允许上游结束时即收到前端 delta 的时序断言，以及关闭浏览器请求后上游连接终止的验证。

真实服务验证已确认最小 JSON 请求通过当前模型的 SSE 接口完成：约 6.53 秒收到完成事件。完整四页生成先返回失败事件，另一次达到 180 秒总超时；网页两页请求返回 HTTP 400。进一步捕获到 `response.failed`，错误码为 `invalid_request`，上游仅返回参数检查提示，未提供具体字段。这些失败没有被当作成功草稿导出。错误记录位于 `artifacts/live-model-stream-Brdu4U/failure.json` 与 `artifacts/stream-browser-failed.json`。兼容性调整与最终结果见下文。

Microsoft PowerPoint 打开、编辑保存及实际放映仍未验收。


### 兼容性调整与真实网页闭环

针对上游的 `invalid_request`，使用相同模型、推理强度、材料和两页目标，仅移除 Responses 请求的 `text.format` 参数进行对照。调整后的请求约 2.807 秒返回首个正文片段，约 4.109 秒完成，收到 98 个正文片段；提纲通过校验，并成功生成静态和动态 PPTX。对应证据在 `artifacts/live-model-noformat-3zkB9d/`。生产代码已采用这一请求形式，仍通过提示词约束 JSON，并对最终结果执行相同的 Zod 结构校验；Chat Completions 的 JSON 参数保持不变。先增加回归断言复现失败，再修改实现，51 项测试重新全部通过。

浏览器进一步使用真实 `gpt-6.1-sol` 模型完成两页生成：首个正文片段约 5.533 秒，第一张完整页面约 6.125 秒，全部结果约 6.979 秒完成。记录到 145 次界面进度或页面更新，第一张页面显示早于完成事件，证明网页确实增量显示而非等完成后统一回放。

在网页中将第二页标题改为“人工调整后再添加动画”，下载静态文件，重新上传到第二阶段，选择自动淡入并下载动态文件。文件中保留修改后的标题，两页共添加 5 个对象动画；22 个非目标 ZIP 部件逐项比较一致。此处验证的是网页编辑与文件交接，没有冒充 PowerPoint 人工编辑或放映。

最终产物位于 `artifacts/browser-stream-z6PhLZ/`：

- `edited-static.pptx`：真实模型生成后经网页调整的静态文件。
- `animated.pptx`：重新上传后生成的自动淡入文件。
- `browser-evidence.json`：模型名、逐次进度、页面显示时间。
- `animation-browser-result.json`：实际下载后的页面反馈。
- `report.json`：时间、对象数、保真核对与文件 SHA-256。
- `streaming-ui.png`：实际生成后的工作台截图。

限制仍需保留：移除格式参数后，四页材料的请求仍曾返回失败事件，不能把全部失败都归因于该参数，也不能据两页样本声称长材料稳定性已通过。当前已验证“同一真实模型、流式网页生成、网页编辑、导出、重新上传、动画加工”的两页样本；较长材料稳定性及 Microsoft PowerPoint 编辑/放映仍待验收。服务失败会明确提示，不自动更换模型、重发请求或导出未完成草稿。

## 连续动态演示（最新需求）

用户明确指出对象淡入不符合预期，要求“像动画一样播放、像动态壁纸一样持续流动、切换平滑优雅”。因此保留旧的对象动画入口，同时新增连续影片路径，不再把对象入场动画当作主要动态效果。

连续路径以用户调整后的 PPTX 为输入，用 LibreOffice 渲染每页，生成 1280×720、30 帧/秒的 H.264 MP4。页面停留期间包含缓慢镜头运动和流动背景，页面之间使用交叉淡化；可设置每页时长、转场时长、背景风格、镜头强度和循环播放。网页实时播放 MP4，并把同一影片字节嵌入动态 PPTX。原始页保留在 PPTX 中作为隐藏的可编辑页面，修改后重新生成影片。

新模块包含：

- `src/cinematic.js`：页面渲染、连续画面合成、动态 PPTX 媒体页打包。
- `src/motion-jobs.js`：任务排队、进度、取消、TTL 清理和文件下载。
- `scripts/render_motion.py`：流动背景、镜头运动、交叉淡化和 FFmpeg 编码。
- 工作台“持续播放 · 平滑转场”面板：内嵌视频预览、进度、停止、PPTX/MP4/原始文件下载。

自动验证：`npm run check` 为 56 项通过，`npm audit --omit=dev` 为 0 个已知漏洞。连续渲染测试确认页面停留期间的两帧有实际变化，跨页邻近帧没有硬切，视频为 H.264 1280×720 30fps，影片内容与 PPTX 内嵌 MP4 字节一致。动态 PPTX 经 LibreOffice 成功打开并转成 PDF；这只验证文件结构和打开能力，不代替 PowerPoint 实际放映验证。

实际工作台验收使用 `artifacts/continuous-demo/original-editable.pptx`，选择“云绸 · 柔蓝”“缓缓流动”、每页 4 秒、转场 1 秒，生成 12 秒影片。浏览器检测视频已加载并自动播放，时长为 12 秒；页面宽度为 1680，390px 移动视口下文档宽度为 390px，没有横向溢出。工作台截图为 `artifacts/cinematic-ui-verified.png`。对应动态 PPTX、MP4 和转 PDF 文件在 `artifacts/continuous-demo/`。

PowerPoint 中媒体页的自动播放、循环和跨版本播放仍需真实桌面 PowerPoint 验收。当前证据可以确认浏览器、MP4 和结构化动态 PPTX 路径已实现与验证，不能声称 PowerPoint 播放体验已经验收。


## 动态效果第二轮调整

复核旧样例后确认，第一版的镜头变化过小，画面更接近静态页面。第二轮将 `flow` 运动增强为明显的慢速推拉、横向漂移、轻微倾斜和柔光扫过，并保留平滑交叉淡化。测试把“页面停留期间有变化”提高为可见运动阈值；30fps 测试样本中页面内两帧平均像素差为 5.72，转场邻近帧平均差为 0.44，说明画面运动明显而转场没有硬切。

工作台重新用同一份三页 PPTX 验收：青屿流光、缓缓流动、每页 4 秒、转场 1 秒，生成 12 秒视频并自动播放。截图为 `artifacts/cinematic-ui-enhanced.png`，强化后的工作台产物为 `artifacts/continuous-demo/ui-motion-enhanced.mp4` 和 `artifacts/continuous-demo/ui-motion-enhanced.pptx`。页面仍保持 390px 移动端无横向溢出。

## 动态效果第三轮调整（2026-10-17）

复核第二轮样片后确认，旧实现的背景分离标记存在实现缺陷：Pillow 灰度图上的填充值没有可靠地标记边缘背景，导致页面整体被当成不透明卡片，镜头运动只能表现为整页平移。新增回归测试先复现该问题，再改用二值图上的边缘连通背景清除。

当前连续渲染路径会在可分离的纯色页面上提取前景，沿空白走廊拆分标题、正文和装饰层。每层使用不同相位的缓慢漂移、推拉和转场位移；背景加入连续柔和光带。最新三页样片每页识别出 6 个前景层，前景 alpha 占比分别为 1.9976%、2.1985%、1.8037%。

最新产物：

- `artifacts/continuous-demo/ui-motion-layered.mp4`
- `artifacts/continuous-demo/ui-motion-layered.pptx`
- `artifacts/continuous-demo/cinematic-layered-contact.png`

验证结果：`npm run check` 为 56 项通过；`npm audit --omit=dev` 为 0 个漏洞；MP4 为 H.264、1280×720、30fps、18 秒；PPTX 内嵌 MP4 与独立 MP4 字节完全一致；LibreOffice 能打开动态 PPTX 并转换为 1 页媒体页 PDF。Microsoft PowerPoint 实际放映、循环和跨版本播放仍未验证。

## 连续动态演示第四轮：原生 Morph 与当前模型配置（2026-10-17）

本轮现场配置确认：`.env` 中的模型为 `gpt-6.1-sol`，协议为 Responses，推理强度为 `high`；本地 `/api/config` 返回 `aiConfigured:true`、`model:gpt-6.1-sol`、`wireApi:responses`、`streaming:true`。凭据仍只在本地环境文件中使用，未写入仓库。

连续动态输出现在同时提供两条下载路径：

- 影片版 PPTX：嵌入由 30fps H.264 MP4 组成的自动播放媒体页，同时保留原始可编辑页面。
- 原生 Morph PPTX：保留 3 个隐藏源页面，并新增 12 个可见关键帧页面；每个关键帧包含 `!!llmpptx:` 对象匹配名、`p159:morph option="byObject"`、自动计时和旧版本 fade 回退。`ppt/presProps.xml` 设置了 `useTimings="1"` 与 `loop="1"`。

最终 18 秒样片的独立核验结果：`npm run check` 为 57 项通过，`npm audit --omit=dev` 为 0 个漏洞；MP4 为 H.264、1280×720、30fps、18 秒；影片版 PPTX 内嵌 MP4 与独立 MP4 字节一致；原生 Morph 包含 3 个源页面和 12 个关键帧，LibreOffice 可将其读取并转换为 12 页 PDF。一次真实 HTTP 动态任务也已完成，返回 `nativeMotionAvailable:true`，影片版与原生 Morph 下载路由均返回 HTTP 200。

`powerPointPlaybackValidated` 仍为 `false`。当前证据覆盖代码测试、浏览器/HTTP 任务、MP4 播放、PPTX ZIP 结构和 LibreOffice 读取；Microsoft PowerPoint 实际放映、Morph 插值效果、循环和跨版本播放仍需在桌面 PowerPoint 中验收。



## 连续动态演示第五轮：错峰文字与持续旋转（2026-10-17）

直接检查旧样片逐帧联系图后确认：整段时长控制运动周期会让长演示的每页运动趋缓，交叉淡化也会让两页文字短暂重叠。本轮改为数秒一周期的前景运动，标题增加轻微缩放和漂移，稀疏弧形装饰独立旋转。转场让旧页文字先退出，新页文字随后进入，共用持续流动的背景。复杂不可分离页面仍使用整页交叉淡化，避免同时叠加半透明层产生亮度下沉。原生 Morph 输出没有同步采用这套影片编排。

先增加失败测试，复现旧实现的转场标题重叠和长演示装饰不旋转，再修复；后续回归覆盖标题缩放、整页不变暗、首尾循环连续。工作台浏览器验证 18 秒 H.264 样片可自动播放、循环、1280×720，现场 `paused:false`，视频时钟持续推进。新样片命名为 `artifacts/continuous-demo/choreographed-motion.mp4` 与 `choreographed-motion.pptx`，转场 GIF 用于快速比较视觉方向。

图层角色依据像素形状推断，尚不等于对任意 PPTX 全部对象的准确语义识别。Microsoft PowerPoint 实际放映、复杂文件效果及用户对视觉风格的验收仍待完成；目标保持 active。

第五轮最终检查：`npm run check` 58 项全部通过；最终 `choreographed-motion.mp4` 为 H.264、1280×720、30fps、18 秒，SHA-256 为 `a7b5a3b4545f398607e0edf1d56a7ce1136851daf2024176070c5613197244cc`，PPTX 内嵌影片字节一致。证据为 `artifacts/continuous-demo/choreography-verification.json`。末次浏览器复核发现此前的 Ego 任务空间已不存在，因此没有重复创建空间；先前旋转与错峰版本的浏览器播放证据有效，最后标题缩放微调的浏览器复核未完成。


## 连续动态演示第六轮：原生 Morph 编排（2026-10-17）

继续核对发现，原生版此前没有区分 gentle/flow 强度，也没有让装饰独立旋转。本轮默认改为每个源场景 6 个关键帧，文字保持竖直，正文框宽高和字号保持不变；弧形装饰旋转，图片与标题分别位移，场景首尾把文字移出画布。加入三个跨场景共享匹配名的柔光组合，置于源内容后方。初次径向透明渐变在 LibreOffice 中出现硬边，因此改为低透明度同心形状组合；用项目中文字体配置重新渲染，确认文字完整，柔光边缘没有此前的硬圆轮廓。

原生 XML 现在设置 advTm=0、advClick=0，关键帧 p14:dur 数值之和与配置的每页时长相同。这表示文件中的计时意图，不能单凭 XML 证明 PowerPoint 的实际插值和放映节奏。复制出的关键帧备注页也改为独立部件，并反向关联自己的关键帧，原始备注部件保留。

最终 `npm run check` 为 61 项通过，依赖审计仍为 0 个漏洞。最终样本 `artifacts/continuous-demo/native-motion-v2.pptx` 为 122138 字节，SHA-256 为 `0528570e7d1a08e43dc6b2320967cc43b52cc40516d0360d5e1b902bbad0453f`；保留 3 个隐藏源页，包含 18 个可见关键帧，逐页对象编号唯一，18 个备注反向关联正确。LibreOffice 导出为 18 页 PDF。验证证据为 `native-v2-verification.json`、`native-v2-keyframes.pdf` 和 `native-v2-visible.png`。

工作台说明明确区分影片预览与原生 Morph 编排，影片版下载对应实际预览。服务已加载本轮代码，/api/config 仍为 gpt-6.1-sol、responses、streaming:true。Microsoft PowerPoint 实际放映、用户视觉风格验收仍待完成，目标继续保持 active。

## 连续动态演示第七轮：真实流式调用、下载闭环与画面比例（2026-10-17）

当前代码将固定 16:9 影片直接铺满源页面，4:3 与竖版 PPTX 会拉伸影片。新增回归先在 4:3 输入上失败（`movie must not stretch`），再改为在保留源页尺寸的前提下等比例居中，空余区域使用深色底。回归覆盖 4:3、竖版、16:9 和超宽页面，同时检查不出画布、完整居中和源页尺寸保留。当前 `npm run check` 为 62 项通过，0 失败；日志位于 `/tmp/llm-pptx-current-check.log`。

服务重新加载当前代码后，真实 `POST /api/cinematic` 上传三页源文件，以青屿流光、flow、每页 6 秒、转场 1.6 秒、循环开启生成；107.5 秒后完成。MP4、影片 PPTX、原生 Morph PPTX、源文件和封面均通过实际 HTTP 下载保存至 `artifacts/live-motion-20261017/`。源文件字节与上传内容一致。

- `continuous-motion.mp4`：18 秒、H.264、1280×720、30fps，完整解码 540 帧，SHA-256 `a7b5a3b4545f398607e0edf1d56a7ce1136851daf2024176070c5613197244cc`。
- `continuous-motion.pptx`：内嵌影片与下载 MP4 逐字节一致，SHA-256 `17b8ef755cd8870881d60015602dd3556d1b5e044dbb3c37ef88299c4e355163`。
- `editable-morph.pptx`：当前路由生成 18 个可见关键帧，各页对象编号无重复。
- `current-transition-contact.png`：直接从本次下载影片抽帧。可见背景光带位置持续变化、装饰旋转、标题先退出再进入下一页，所抽取的转场帧中没有两页标题重叠。

在缩小至 640×360 的解码帧上，相邻帧平均 MAE 0.940、最大 MAE 2.483、首尾循环接缝 MAE 1.345，第一页 1 秒与 3 秒帧差 MAE 10.063。数值说明影片包含连续变化，并可定位异常帧差；不能替代用户对优雅程度的视觉评价。独立媒体证据为 `media-verification.json`，HTTP 和 SSE 证据为 `http-verification.json`。

本轮同时通过真实 `/api/plan/stream` 调用模型：配置接口为 `gpt-6.1-sol / responses / streaming:true`，本机 Codex 有效配置为 `gpt-6.1-sol / high`。收到 152 个 delta 事件，首段约 5.53 秒、末段约 7.86 秒，约 7.87 秒完成两页已校验草稿；`streamed-outline.json` 保存结果。不输出或保存服务凭据。

4:3 媒体页的影片范围为 x=0、y=857250、cx=9144000、cy=5143500（EMU），源页仍为 9144000×6858000。LibreOffice 能将该文件导出为 720×540pt 的单页 PDF，但导出的 PDF 未显示媒体画面，因此这条静态导出不构成画面比例或实际视频播放的视觉证据。比例修复当前由生成包中的实际几何和回归覆盖证明。

此前 Ego 浏览器任务空间已经不存在，现有唯一空间属于用户的其他任务，本轮未创建替代空间或操作该页面。当前版网页交互、Microsoft PowerPoint 的媒体自动播放和 Morph 插值仍未实测，用户视觉验收也仍待完成；目标继续保持 active。

## 连续动态演示第八轮：透明描边图形与转场边界（2026-10-17）

新增像素回归先复现了一个边界问题：页面边缘附近的图层在停留阶段被限制在画布内，转场刚开始时却解除限制，可能出现单帧裁切跳变。修复后基础运动在停留和转场阶段共用同一组画布约束，只让明确的进入/离场位移离开画布。该回归覆盖标题、图片和整页三种图层以及进入、离场两个方向；像素编排测试 6 项通过，`npm run check` 为 62 项通过，0 失败。

随后构造包含大尺寸透明圆环和环上圆点的真实 PPTX，通过当前服务重新上传并生成 8 秒、30fps、循环影片。新的页面层报告将圆环识别为 `ornament`，前景 alpha 占比从原来的约 25% 降为约 2.9%，说明圆环内部的大面积空洞已恢复为透明。抽帧联系图 `artifacts/smooth-boundaries-20261017/edge-orbits/final-contact.png` 显示：光带穿过圆环内部，圆点沿圆环移动，转场时旧圆环和新圆环平滑错开。

该样本的 `final-verification.json` 记录：完整解码 240 帧，圆环中心 RGB 三通道变化范围 `[47, 44, 52]`，说明空洞确实看到持续变化的背景；相邻帧平均 MAE 2.269，循环接缝 MAE 1.303；影片版 PPTX 内嵌 MP4 与独立影片完全一致。样本文件位于 `artifacts/smooth-boundaries-20261017/edge-orbits/`。

空洞恢复采用保守规则：仅移除面积和跨度都较大的、被前景围住的纯色区域，用于识别圆环、弧线和边框内部；小面积字形空隙仍按前景保留。Microsoft PowerPoint 的实际播放、Morph 插值和最终用户审美验收仍待完成，目标继续保持 active。

第八轮浏览器补充验收：新建独立任务空间 52，真实上传圆环源 PPTX，在网页设置每页 4 秒、转场 1.6 秒，完成 8 秒影片生成。浏览器返回 `paused:false`、`loop:true`、`readyState:4`、1280×720；时间从 0.073 秒推进到 1.099 秒，随后又从 5.523 秒推进到 7.529 秒，证明当前修复版确实自动播放而非停留在封面。证据为 `browser-playback.png` 和 `browser-verification.json`。保留结果页供查看；Microsoft PowerPoint 实际放映和用户视觉风格验收仍待完成。

### 第八轮最终保护与交付（2026-10-18）

最终将大面积空洞恢复与 PPTX 结构绑定：要求页面显式使用纯色背景，形状及文字使用可确认的原生填充，版式和母版没有额外可见图形。图片、图表、组合、同色实心填充、不明确的文字颜色、复杂填充或效果均保留原有像素遮挡。透明、半透明描边和独立实色圆点可被识别；背景色与渲染画面不匹配时也不清空内部区域。新增 Node 回归覆盖透明圆环、同色实心圆、图片、背景色文字和母版装饰，Python 回归覆盖无提示、拒绝提示和底色不匹配的保留行为。

最终检查为 `npm run check` 63 项通过、0 失败；像素编排测试共 7 项通过。日志为 `/tmp/llm-pptx-final-protected-check.log`。当前运行服务已重启加载最终代码。

最终真实 HTTP 上传与下载文件保存至 `artifacts/continuous-orbits-20261018/`：影片 `motion.mp4` 为 8 秒、1280×720、30fps，SHA-256 `b576c0b6faa6a8a8f1cf817ddeafe0c9a95f66a6627331d8088dcdc0fbea0af3`；`motion.pptx` 嵌入完全相同的影片字节，`editable-morph.pptx` 提供独立的原生关键帧版本。结构保护开启后，视频字节与此前真实浏览器已播放的圆环影片一致。最终代码重新计算的分离提示与实际生成任务中的提示一致，证据为 `verification.json` 与 `final-audit.json`。

针对同一真实圆环页面，在最终空洞分离基础上对比旧、新边界处理：转场趋近零进度时，旧边界逻辑使两页分别有 50658 和 44528 个像素发生突然变化，修复后两页均为 0 个变化像素。该检查固定时间，仅改变无穷小的转场进度；证据为 `artifacts/smooth-boundaries-20261017/edge-orbits/final-boundary-continuity.json`。

最终剩余验证是 Microsoft PowerPoint 实际放映（媒体自动播放、循环与 Morph 插值）以及用户对视觉风格的判断。应用目录中未找到 Microsoft PowerPoint，文档连接工具也未发现任何已连接的 PowerPoint 会话。第六、第七及本轮连续复核均保留了这一外部验证缺口；当前不能用 MP4、XML、LibreOffice 或测试结果替代该结论。
