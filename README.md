# dsh-knowledge-base — DeepSeek Harness 知识库插件

把 Word / PPT / PDF（文字版与扫描版）等资料整理成**适合大模型阅读、学习的形式**，
存放在**固定、可命名、可导出、可持续修订**的知识库中；deepseek 通过一组 `kb_*` 工具
随时调用知识库内容进行问答、推理、整理、课件与文档制作等工作。

## 能力

| 工具 | 作用 |
| --- | --- |
| `kb_import` | 导入文件或目录（.docx / .doc 自动转换 / .pptx / .pdf / .md / .txt / .epub / .mobi / .azw3，扫描版 PDF 自动逐页 OCR 中文；.txt 自动识别 UTF-8/UTF-16/GBK；MOBI/AZW3 自动经 Calibre 转 EPUB）。旧版 .doc/.ppt 与 MOBI/AZW3 一律在后台任务中转换；正在导入中的同名文档自动跳过。**导入前自动查重**：同库重合跳过、跨库重合默认跳过并报告（见下文） |
| `kb_list` | 列出知识库 / 知识库内文档与状态 |
| `kb_query` | 全文检索（ripgrep 正则，中文短语直接搜） |
| `kb_read` | 按分块精读、读大纲、读整篇 |
| `kb_view` | 查看原始页面图片（PDF 按页渲染；Word/PPT/EPUB/MOBI 提取内嵌图）——公式、原理图、电路图专用 |
| `kb_edit` | 精确替换修订（持续修改完善） |
| `kb_add_note` | 沉淀笔记 / 分析结论（单篇上限 2MB） |
| `kb_remove` | 删除文档或整个知识库（删整库需 `removeKb=true` 且 `confirm` 逐字等于知识库名称） |
| `kb_export` | 导出 md（单文件）/ jsonl（分块，RAG 用）/ zip（完整包，内置 JSZip 打包，不依赖系统命令） |
| `kb_rename` | 重命名知识库 |

大文件（如整本扫描书）导入自动转为**后台任务**，与内置 `job_list` / `job_output` 联动查看进度；
取消后台任务会在 `job_output` 中显示为 cancelled。后台任务会写逐文件统计：
**只要有文件失败，任务状态就是 `failed`（详情写明“部分失败：成功 X，失败 Y”）**，不再把部分失败显示成完成。

**旧版 .doc 自动转换**：Windows 用本机 Microsoft Word（COM 自动化，无对话框、禁宏）；
macOS 用自带 `textutil`；Linux 可用 LibreOffice。未装任何转换工具时会给出明确提示。

## 知识库存储结构（默认 `~/.dsh/knowledge/<知识库名>/`）

```
kb.json                    清单：文档列表（id/标题/类型/页数/大纲/版本/状态）
sources/<docId><ext>       原始文件（逐字节保留）
markdown/<docId>/<docId>.md   合并版（整篇通读）
markdown/<docId>/parts/NNNN.md 分块版（检索、精读、RAG）
exports/                   导出产物
```

- **知识库名称**：`kb_import` 的 `kb` 参数决定（可含中文），不存在即创建。
- **持续修改**：同名文件重复导入 = 原位更新（版本号 +1）；`kb_edit` 精确替换；
  `kb_add_note` 追加新知识。清单会记录每个文档的 `sourcePath`：**同一路径**重复导入是原位更新，
  不同目录下的同名文件（如 `A/通知.pdf` 与 `B/通知.pdf`）会另建文档，不会互相覆盖。
  旧版本清单没有 `sourcePath` 的条目无法追溯来源，首次重导仍按原位更新，并在导入结果的
  warnings 里提示一次；担心覆盖时请先备份或导入到新库，重导一次后就会记录来源路径。
- **导出**：md 适合直接上传对话类产品；jsonl 适合 RAG 管道；zip 是完整可迁移包
  （含 README 说明与全部 markdown，`includeSources=true` 时含原始文件）。

## 导入前查重（kb_import 内置）

`kb_import` 在解析/OCR 之前，先用**文件名/标题**与当前知识库及全部知识库比对，
把匹配分成两档：

- **重合（exact）**：标准号/年份/版本桶一致，或标题规范化后完全相同 → 按规则跳过；
  - 同库重合 → 始终跳过（同路径同名文件例外：按原位更新，版本号 +1）；
  - 跨库重合 → 默认跳过并在结果中列出；确认需要时加 `allowCrossDuplicates: true` 重新执行。
- **相似（similar）**：短标题是长标题的完整前缀等低置信匹配（如「XX导则」vs「XX导则（试行）」）
  → **照常导入**，并在结果里列出候选，提示人工确认。相似不自动跳过，是为了避免把
  「国网浙江省电力有限公司电能质量管理规定」和以同一单位名开头的另一份通知误当成重复丢掉。

比对口径（`lib/dedup.js`）：

- 标准号归一：`GB/T = GBT`、`DL/T = DLT`、`Q/GDW = Q_GDW`，连字符/破折号（`- — – ~ ～`）
  等同，部分号小数点保留（`10650.2 ≠ 10650`）；
- 年份：双方都有年份时必须相同；一方无年份（如无年份的报批稿）不判重合——可能是新修订；
- 版本桶：发布稿/无标记、报批稿、征求意见稿、编制说明、送审稿、草案等互不判重合；
- 部/分册标记：`第N部分 / 第N分册 / 第N篇 / 第N卷` 不同的文件不判重合
  （`XX导则 第1部分` 与 `第2部分` 是两份文件）；
- 无标准号的文件按核心短语比对：规范化（去空白/标点、全半角归一）后**完全相等**才算重合；
  只是完整前缀的算相似，不自动跳过；仅共享一段公共前缀（如相同的单位名开头）不算匹配。

回归测试：`npm test`（隔离临时目录，不依赖本机知识库）。`node dev/dedup-test.mjs` 是早期
依赖本机知识库内容的开发脚本，内容变化后其固定 id 断言可能过期，不作为发布门禁。

## 配置（cordis.patch.yml 中该插件的 config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `kbRoot` | `~/.dsh/knowledge` | 知识库根目录 |
| `defaultKb` | `default` | 未指定 kb 时的默认知识库 |
| `ocrLang` | `chi_sim+eng` | OCR 语言（竖排古籍可试 `chi_sim_vert`） |
| `ocrWorkers` | `0`（自动） | OCR 并行 worker 数；0 = 按本机 CPU/内存自适应：`min(核数一半, 内存/1.5GB)`，下限 2、上限 16（24 线程/32GB 机器 ≈ 12） |
| `ocrDpi` | `0`（自动） | 扫描页渲染分辨率；0 = 300 DPI（tesseract best 模型的设计分辨率；低清扫描源可显式调低，上限 400） |
| `ocrEngine` | `auto` | OCR 引擎：auto（rapidocr > tesserocr > 原生 tesseract > wasm 兜底）/ rapidocr / tesseract / wasm |
| `ocrNativeBin` | `""` | 原生 tesseract / tesserocr 环境的显式二进制或 python 路径（留空自动探测） |
| `ocrPythonBin` | `""` | rapidocr 环境的显式 python 路径（留空自动探测 `~/.dsh/tools/rapidocr-env` 与 PATH） |
| `ebookConvertBin` | `""` | Calibre ebook-convert 的显式路径（MOBI/AZW3 转换用；留空自动探测 PATH、`~/.dsh/tools/calibre`、macOS 默认安装位置） |
| `maxInlinePages` | 20 | 超过则转入后台任务导入 |
| `maxInlineBytes` | 10MB | 文件总字节数超过则转入后台任务导入 |
| `partMaxChars` | 8000 | 分块大小（字符） |
| `readMaxChars` | 20000 | kb_read 单次返回上限 |
| `queryMaxMatches` | 40 | kb_query 单次返回的匹配行上限 |
| `queryLineBytes` | 400 | kb_query 单行预览的最大字节数 |
| `importTimeoutMs` | 600000 | kb_import 工具调用超时（内联导入） |

> 引擎选择：默认只有内置 **tesseract.js（WASM）** 可用，零安装、全平台可移植。
> 可选加速：`~/.dsh/tools/rapidocr-env` 装 RapidOCR（Python，中文印刷页最快）或
> `~/.dsh/tools/tesseract-env` 装原生 tesseract（Windows 用 micromamba 建环境，
> 二进制探测支持 conda 的 `Library/bin`/`Scripts` 布局）；在 tesseract-env 中
> `micromamba install -c conda-forge tesserocr pillow` 后会启用**常驻 tesserocr 后端**
> （引擎常驻内存，免去原生 tesseract 每页进程启动与模型重载的开销）。
> 多个后端都被探测到后 `auto` 自动择优。

## 中文 OCR 模型数据

`data/tessdata/` 预置 tesseract 中文模型（chi_sim / chi_sim_vert / eng，best 版，
仅保留 `.traineddata.gz` —— tesseract.js（WASM）与 tesseract 4.00+/tesserocr
均可直接读取 gz 格式）。缺失时可重新下载：

```bash
mkdir -p data/tessdata
cd data/tessdata
for l in chi_sim chi_sim_vert eng; do
  curl -fL "https://tessdata.projectnaptha.com/4.0.0_best_int/$l.traineddata.gz" -o "$l.traineddata.gz"
done
```

> **新机器/打包安装请先确认模型存在**。插件的 `.gitignore` 不提交 `data/tessdata/`（约 35 MB），
> 所以从 Git 克隆或 npm 包安装后，第一次 OCR 会直接报“OCR 语言模型缺失”，并给出上述下载命令
> （不再抛 tesseract 的底层异常）。知识库根目录下的 `.plugin-load.log` 也会记录
> `tessdata=ok` 或 `tessdata=missing:chi_sim+eng`。`chi_sim+eng` 会检查两个模型，缺一即报错。

## 测试

```bash
npm test          # node:test；覆盖查重精度、同名文件保护、后台失败统计、检索截断/单文档上限、
                  # 相似导入提示、OCR 模型检查（全部使用临时目录，不依赖本机知识库）
```

## 使用示例（对 harness 直接说）

- “把 /Users/me/资料 目录导入知识库「项目管理」，其中有两本扫描版书，导入后告诉我结构”
- “在知识库「项目管理」里查一下‘进度偏差 纠偏措施’，结合上下文给我分析”
- “把知识库中关于 XX 的内容整理成一份 20 页的培训课件（PPT 结构）”
- “把刚才的分析结论补充进知识库”
- “导出知识库为 markdown 单文件，我要上传给其他 AI”

## 插件实现说明

- 纯 JS/WASM 解析栈：mammoth（Word）、JSZip+fast-xml-parser（PPT）、
  mupdf（PDF 文字层/渲染）、tesseract.js（OCR）、@vscode/ripgrep（检索）——
  除 npm 依赖外无系统要求；导出 zip 同样用内置 JSZip 打包，不依赖系统 `zip`/`tar`。
- .doc/.ppt 转换跨平台：Windows → Word/PowerPoint COM；macOS → textutil；Linux → LibreOffice；
  转换全部异步执行（不阻塞宿主事件循环），旧格式导入强制走后台任务。
- MOBI/AZW3 电子书经 Calibre `ebook-convert` 转 EPUB 后复用 EPUB 解析管线（未安装 Calibre
  时给出明确提示）；转换同样只在后台 worker 中执行。
- OCR 并发数与 DPI 按本机 CPU 核数/内存自适应（见配置表），无需手工按机器调参；
  rapidocr/tesserocr 后端为常驻进程帧协议，模型只加载一次。
- 后台导入 = 子进程 worker + harness 原生 jobs 服务（`ctx.jobs`），可取消（显示为
  cancelled）、可流式看进度；worker 支持 `@json文件` 方式传参，避免 Windows 命令行
  长度/引号截断。
- 所有写入经暂存目录原子提交；清单更新带目录锁，支持并发安全；同一文档 30 分钟内的
  重复导入自动跳过；插件加载时会自动清扫崩溃遗留的 `import-tmp` 暂存目录。
- 导出（md/jsonl）流式写入、zip 用 Node 流直接进 JSZip，超大知识库不产生内存尖峰。
- 每个文档 `type` 自动判定：`pdf-text` / `pdf-scanned` / `pdf-mixed`。

## 接入方式

### 从源码安装（Git 仓库，通用）

仓库不包含 `node_modules/` 与 OCR 模型，克隆后按顺序执行：

```bash
cd dsh-knowledge-base
npm install          # 安装依赖（生成 node_modules/）
```

然后下载中文 OCR 模型（见上文「中文 OCR 模型数据」的下载脚本，`data/tessdata/` 与
`data/tessdata-fast/` 各一份）。需要 MOBI/AZW3 时另外安装 [Calibre](https://calibre-ebook.com/)
并确保 `ebook-convert` 在 PATH 中（或配置 `ebookConvertBin` 指向它）。
之后按平台继续下面的 Windows / macOS / Linux 步骤。

### Windows

1. 打包分发版插件目录内自带 `node_modules/`（依赖自包含）与 `data/tessdata/` 中文 OCR 模型；
   从 Git 源码安装时按上一节先执行 `npm install` 并下载模型。
2. 运行一键脚本（普通 PowerShell 即可，无需管理员权限）：
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\Users\Moon\.dsh\plugins\dsh-knowledge-base\install-to-machine.ps1
   ```
   脚本做三件事：建立目录联接 `~/.dsh/profiles/node_modules/dsh-knowledge-base`、
   把注册行写入 `~/.dsh/profiles/web/cordis.patch.yml`、启用 HMR 监视插件源码。
   也可手工执行等价操作（`cmd /c mklink /J <目标> <插件目录>` + 编辑 cordis.patch.yml）。
3. 正在运行的 `dsh web` 会**热应用** cordis.patch.yml 的变更——知识库根目录
   （`~/.dsh/knowledge`）下出现 `.plugin-load.log` 即加载成功；否则重启 `dsh web`。
4. 新开一个会话，说“调用 kb_list”验证。

### macOS / Linux

参照仓库根目录的 `install-to-machine.sh`（软链 + cordis.patch.yml 注册，macOS 用软链替代目录联接）。

## 标准更新检查（kb_std_check）

对知识库（默认「标准」库）中的标准做更新检查：从文档标题自动提取标准号（GB/NB/DL/QGDW/IEC/团体标准等），
在标准网 biaozhun.org 逐条检索比对年份；发现新版本或「草案已有正式版」时，用登录会话自动下载 PDF
并直接导入知识库（旧版原文保留）。支持 `check`（只报告）/ `check-download`（默认，检查并下载）、
`force`（忽略 7 天缓存全查）、`limit`（分批）、`dryRun`（模拟）。

- 增量缓存：`<kbDir>/.std-check.json`（中断后再次调用自动续查）
- 下载凭据：config `bzCookie` —— 用户在浏览器登录 biaozhun.org 后提供的 Cookie 串
  （站点仅微信扫码登录；未配置时工具只做检查报告）
- 请求限速：config `stdRateMs`（默认 1200ms/次），防站点封控
- 站点每次下载消耗 6 金币（VIP 免金币），金币不足的标准在报告中列出失败原因
