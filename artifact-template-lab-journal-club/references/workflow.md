# 执行说明：复用本地解析与排版

用户只需提供论文与要求，不必准备 JSON 或运行命令。以下操作由 Codex 完成。

## 环境与目录

调用 `load_workspace_dependencies`，取得当前 bundled Node、Python、Node modules 路径。读取当前已安装 Presentations 技能的 implementation/finalization 指南，使用其操作标记与验证流程。使用当前任务 `work/` 存放提取、原图、计划、草稿、渲染和验证报告，`outputs/` 只放成品。不要改原论文与技能 assets/reference.pptx。

脚本不调用模型、网络或 OCR。现有依赖为 pypdf、Poppler 与 @oai/artifact-tool；不要为了运行模板安装到或修改 bundled runtime。遇到缺依赖时先重新检查依赖定位，再说明具体缺项。

PowerShell 中下列变量都由实际解析出的路径赋值，不需要写死账户或版本目录：

```powershell
$env:PYTHONUTF8 = '1'
& $runtimePython "$skillDir/scripts/prepare_paper.py" $paperPath --out-dir "$taskDir/work/paper"
```

终端摘要含 `cache_hit`、正文文件、manifest、warnings。先读 manifest，再按页/段落读取正文；无需把 JSON/XML 全部打印。缓存 `.cache/` 按完整源 hash 与脚本版本校验。更换论文会生成新缓存；不要使用旧论文的图文。

## 原图与文字

PDF 的来源编号是文件物理页，从 1 开始。先检查需要的图页，再裁剪：

```powershell
& $runtimePython "$skillDir/scripts/prepare_paper.py" $paperPath --out-dir "$taskDir/work/paper" --render-pages 3,5 --dpi 160
& $runtimePython "$skillDir/scripts/prepare_paper.py" $paperPath --out-dir "$taskDir/work/paper" --crop 3 40 80 550 420 --crop-output "$taskDir/work/figure-1.png" --dpi 220
```

crop 参数依次为页码、X0、Y0、X1、Y1；相对显示页 CropBox 左上角，单位 PDF point（72 point＝1 英寸）。坐标应通过原页检查确定，示例数值不是通用裁剪框。选择足以清晰展示 panel 标签和坐标轴的分辨率；保留相关图例。Poppler 自动从 bundled Python 的 dependencies 目录定位，也可传 `--poppler-dir`。

DOCX 输出段落、表格及单元格编号；manifest.media 提供内嵌图片与正文关系，路径相对提取输出目录。图片可能重复使用且未带标题，必须与正文/图注确认对应。Word 页码不稳定，不推测页码。公式、修订、脚注等有提取限制时看 manifest 警告，必要时用 Documents 渲染核对；不能忽略会影响结论的内容。

低文本 PDF 页可能是扫描页、图页或空白页。先视觉检查；不要把缺失正文当作作者没有报告。双栏 PDF 的顺序、上下标和公式也要核对。

## 证据与逐页计划

在 `work/` 保存简短 `evidence.json`，每条包含 claim、source_location、figure/panels、比较组、必要统计条件，以及作者结论或汇报者评价。它是可追溯工作记录，不要整份塞入用户 PPT。

按照 [plan-format.md](plan-format.md) 写 plan：

- 封面：新论文中文标题、原始题录/论文头图、用户给出的汇报人及日期。缺题录图时使用原生文本题录。未给汇报人则省略姓名；未给日期时不沿用旧日期，使用当天日期并标明「制作日期」或省略。
- 原图页：英文 Figure 标题、按实验问题选择的原图 panel、中文简释及必要结论。主文主要结果、决定结论的阴性结果和关键补充图都要合理覆盖。
- 回答页：在当前研究条件下能得出的回答，不能把相关性升级成证实机制。
- 作者介绍和背景页：只有资料充分且有助于理解才加入。没有当前课题背景时不写成已经适用于用户课题。
- `source`/notes：文件名、物理页或 Word 索引、图号和 panel，必要时补 DOI。样式来源与科学来源分开。

把 `RUNTIME_NODE_MODULES` 设置为依赖工具返回的模块目录，然后运行：

```powershell
$env:RUNTIME_NODE_MODULES = $runtimeNodeModules
& $runtimeNode "$skillDir/scripts/build_deck.mjs" --plan "$taskDir/work/plan.json" --out-dir "$taskDir/work/build" --template "$skillDir/assets/reference.pptx" --no-render
```

脚本本身默认渲染所有页；上面的正常调用暂不渲染，留到 finalizer 后一次渲染最终成品。需要调试版式时才渲染草稿，支持的特殊开关以 `--help` 为准。超长文本或缺图应先修订 plan，不能用缩小字体掩盖问题。把新图表做为原生对象的特殊需求交给当前 Presentations 技能；不要把截图中的数字凭外观重建为数据。

## 验证与交付

草稿不是最终成品。按 Presentations finalizer 传入源画布 `9144000,6858000`、实际页数和字体策略。字体依据为 reference：楷体、Times New Roman；只有实际使用宋体等补充字体时才列入。最终文件名使用新路径，不覆盖源文件。

常规页型可以复用封装脚本，它执行当前 Presentations 的验证器并渲染最终文件：

```powershell
& $runtimeNode "$skillDir/scripts/finalize_deck.mjs" --manifest "$taskDir/work/build/manifest.json" --workspace $taskDir --output "$taskDir/outputs/文献汇报.pptx" --presentations-skill $presentationsSkillDir --python $runtimePython
```

若另外加入必须原生化的表格或图表，使用当前 Presentations 的完整 finalizer 配置声明相应 slide ownership 要求，不能把这些特殊要求当普通图页跳过。最终预览可在同版本下复用，无需为相同文件反复渲染。

查看每页最终渲染，确认图的可读性、黄色高亮、文本无裁切/遮挡，并对照新论文检查关键事实和来源。首次生成或全局版式修改检查全套；局部修订重点看受影响页，同时扫描整套一致性。PDF/DOCX 解析缓存和 plan 留在任务工作目录，下一次局部修改继续复用。

用户没有要求讲稿、PDF、副版本时只交付 PPTX。第一次实际论文制作需要真正核读论文，不能把技能的合成测试误报成已经验证任何医学结论。
