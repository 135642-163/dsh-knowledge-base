# dsh-knowledge-wiki 一键接入脚本（Windows 版）
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File install-to-machine.ps1 [-PluginDir <目录>] [-KbRoot <目录>] [-DefaultKb <名称>]
#
# 前提: 已安装 DeepSeek Harness 且至少启动过一次 web profile（生成 profiles/ 目录）。
# 脚本做三件事:
#   1. 建立目录联接 profiles\node_modules\dsh-knowledge-wiki -> 插件目录（无需管理员权限）
#   2. 把插件注册行写入 profiles\web\cordis.patch.yml（保留已有内容）
#   3. 启用 HMR 监视插件源码，编辑代码热重载
# 完成后重启 dsh web（若正在运行，cordis.patch.yml 的变更也会被热应用）。
param(
  [string]$PluginDir = "",
  [string]$KbRoot = "",
  [string]$DefaultKb = "default"
)

$ErrorActionPreference = "Stop"
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$ProfileDir = Join-Path $DshHome "profiles\web"
$ModulesDir = Join-Path $DshHome "profiles\node_modules"
$PatchFile = Join-Path $ProfileDir "cordis.patch.yml"

if (-not $PluginDir) { $PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $KbRoot) { $KbRoot = Join-Path $DshHome "knowledge" }

if (-not (Test-Path (Join-Path $PluginDir "lib\index.js"))) {
  throw "$PluginDir 不是 dsh-knowledge-wiki 插件目录"
}

New-Item -ItemType Directory -Path $ProfileDir, $ModulesDir -Force | Out-Null

$link = Join-Path $ModulesDir "dsh-knowledge-wiki"
if (Test-Path $link) {
  Write-Host "目录联接已存在: $link（跳过）"
} else {
  cmd /c mklink /J "`"$link`"" "`"$PluginDir`"" | Out-Null
  if (-not (Test-Path $link)) { throw "创建目录联接失败: $link" }
  Write-Host "已创建目录联接: $link -> $PluginDir"
}

$needInsert = -not (Test-Path $PatchFile) -or -not (Select-String -Path $PatchFile -Pattern "id: knowledge-wiki" -Quiet)
if ($needInsert) {
  $forward = $PluginDir.Replace("\", "/")
  $insertText = @"

# dsh-knowledge-wiki 知识库插件（由 install-to-machine.ps1 添加，路径: $forward）
- insert:
    - id: knowledge-wiki
      name: dsh-knowledge-wiki
      config:
        kbRoot: $($KbRoot.Replace("\", "/"))
        defaultKb: $DefaultKb
        ocrLang: chi_sim+eng
        # ocrWorkers / ocrDpi 不显式设置 = 插件按本机 CPU/内存自适应

# 监视插件源码目录（编辑插件代码热重载；如不需要可删除本段）
- id: hmr
  disabled: false
  config:
    root:
      - .
      - $forward
"@
  # 用无 BOM 的 UTF-8 追加写入：PowerShell 5.1 的 Add-Content -Encoding UTF8 会写 BOM，
  # 追加时可能把 U+FEFF 插进文件中间导致 YAML 解析失败
  [System.IO.File]::AppendAllText($PatchFile, $insertText, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "已写入注册配置: $PatchFile"
} else {
  Write-Host "cordis.patch.yml 已包含 knowledge-wiki 注册行（跳过写入）"
}

Write-Host @"

安装完成:
  插件目录:   $PluginDir
  知识库根:   $KbRoot
  目录联接:   $link
  注册配置:   $PatchFile

下一步:
  1. 若 dsh web 正在运行，cordis.patch.yml 的变更会被热应用（知识库根目录出现
     .plugin-load.log 即加载成功）；否则重新运行 dsh web。
  2. 打开网页新开会话，说"调用 kb_list"验证。

提示:
  - .doc 旧版 Word 依赖本机 Microsoft Word（COM 自动化）；未装 Word 请手动另存 .docx。
  - OCR 默认用内置 WASM 引擎，按 CPU/内存自动开并发（24 线程/32GB 机器 ≈ 12 worker / 300 DPI）。
"@
