# dsh-knowledge-wiki 0.35.2 Windows 验收清单

> 发给 Windows 端执行。目标：确认 0.35.2 安装正常，并复测 0.35.1 修复的 3 个问题 + 卡片颜色。
>
> **安全边界**：只读检查和 `导入回归-20261101` 测试库写入；不要动真实资料库
> （变电试验/标准/历史/电能质量/电气一次/电气二次/电气工程教材/ima 等）。

## 1. 版本确认

在 dsh-market 更新 `dsh-knowledge-wiki` 到 **0.35.2**，更新后：

- HMR 未生效时重启桌面端；
- 打开 `/kb/` 工作台；
- 确认 `GET /kb/api/status` 返回 `"version":"0.35.2"`；
- 预期工具数 **23**，注册结果全部为 `ok`，无 `FAIL`。

## 2. 一键自检脚本（PowerShell）

把下面内容保存为 `check-kb.ps1`（UTF-8 即可，脚本输出为英文，避免 5.1 中文编码问题）。

```powershell
param(
  [Parameter(Mandatory = $true)][int]$Port,
  [string]$ExpectedVersion = "0.35.2",
  [int]$ExpectedToolCount = 23,
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:$Port"
$failed = 0
$results = New-Object System.Collections.Generic.List[object]

function Check([string]$Name, [bool]$Ok, [string]$Detail = "") {
  $script:results.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Detail = $Detail }) | Out-Null
  if ($Ok) { Write-Host ("[PASS] " + $Name + $(if ($Detail) { " - $Detail" } else { "" })) -ForegroundColor Green }
  else { Write-Host ("[FAIL] " + $Name + $(if ($Detail) { " - $Detail" } else { "" })) -ForegroundColor Red; $script:failed++ }
}

Write-Host "dsh-knowledge-wiki Windows self-check" -ForegroundColor Cyan
Write-Host "base: $base"
Write-Host ""

# 1) status / version / kbRoot
try {
  $status = Invoke-RestMethod -Uri "$base/kb/api/status" -TimeoutSec 10
  Check "GET /kb/api/status" $true
  Check "version is $ExpectedVersion" ($status.version -eq $ExpectedVersion) "actual=$($status.version)"
  Check "status.ok" ($status.ok -eq $true) "actual=$($status.ok)"
  Check "kbRootOk" ($status.kbRootOk -eq $true) "kbRoot=$($status.kbRoot)"
  Check "features.merge" ($status.features.merge -eq $true) "actual=$($status.features.merge)"
} catch {
  Check "GET /kb/api/status" $false $_.Exception.Message
  Write-Host "RESULT: FAIL (cannot reach host)" -ForegroundColor Red
  exit 1
}

# 2) workbench assets
try {
  $html = Invoke-WebRequest -Uri "$base/kb/" -UseBasicParsing -TimeoutSec 10
  Check "GET /kb/ html" ($html.StatusCode -eq 200 -and $html.Content -match "知识库工作台")
  $app = Invoke-WebRequest -Uri "$base/kb/app.js" -UseBasicParsing -TimeoutSec 10
  Check "GET /kb/app.js" ($app.StatusCode -eq 200 -and $app.RawContentLength -gt 1000) "bytes=$($app.RawContentLength)"
  $css = Invoke-WebRequest -Uri "$base/kb/style.css" -UseBasicParsing -TimeoutSec 10
  Check "GET /kb/style.css" ($css.StatusCode -eq 200 -and $css.RawContentLength -gt 1000) "bytes=$($css.RawContentLength)"
} catch {
  Check "workbench assets" $false $_.Exception.Message
}

# 3) KB list endpoint
try {
  $kbs = Invoke-RestMethod -Uri "$base/kb/api/kbs" -TimeoutSec 10
  $count = @($kbs.kbs).Count
  Check "GET /kb/api/kbs" ($count -gt 0) "kbs=$count"
} catch {
  Check "GET /kb/api/kbs" $false $_.Exception.Message
}

# 4) plugin load log: registrations + tool count
$logPath = Join-Path ([string]$status.kbRoot) ".plugin-load.log"
Check "plugin-load.log exists" (Test-Path $logPath) $logPath
if (Test-Path $logPath) {
  $line = Get-Content -Path $logPath -Tail 500 |
    Where-Object { $_ -match "dsh-knowledge-wiki applied" } |
    Select-Object -Last 1
  if (-not $line) {
    Check "dsh-knowledge-wiki applied line" $false "not found in last 500 lines"
  } else {
    Check "dsh-knowledge-wiki applied line" $true
    if ($line -match "registrations=\[([^\]]*)\]") {
      $regs = $matches[1] -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
      $okCount = @($regs | Where-Object { $_ -eq "ok" }).Count
      $failCount = @($regs | Where-Object { $_ -match "FAIL" }).Count
      Check "registration count = $ExpectedToolCount" ($regs.Count -eq $ExpectedToolCount) "actual=$($regs.Count)"
      Check "all registrations ok" ($okCount -eq $ExpectedToolCount -and $failCount -eq 0) "ok=$okCount fail=$failCount"
    } else {
      Check "registrations parse" $false "registrations=[...] not found"
    }
    if ($line -match "tools=\[([^\]]*)\]") {
      $tools = $matches[1] -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
      Check "tool list count = $ExpectedToolCount" ($tools.Count -eq $ExpectedToolCount) "actual=$($tools.Count)"
    } else {
      Check "tools parse" $false "tools=[...] not found"
    }
  }
}

# 5) optional marketplace update state (does not fail acceptance)
try {
  $updates = Invoke-RestMethod -Uri "$base/dsh-market/updates" -TimeoutSec 10
  $row = @($updates.packages | Where-Object { $_.name -eq "dsh-knowledge-wiki" })[0]
  if ($row) {
    Write-Host "[INFO] dsh-market: current=$($row.current) updateAvailable=$($row.updateAvailable)"
    if ($row.updateAvailable -eq $true) { Write-Host "[WARN] marketplace still reports an update; refresh/update before testing." -ForegroundColor Yellow }
  }
} catch {
  Write-Host "[INFO] /dsh-market/updates not available; skip."
}

# 6) summary
Write-Host ""
if ($failed -eq 0) {
  Write-Host "RESULT: PASS (all checks)" -ForegroundColor Green
} else {
  Write-Host "RESULT: FAIL ($failed checks failed)" -ForegroundColor Red
}
$out = if ($OutFile) { $OutFile } else { Join-Path (Get-Location) "kb-windows-selfcheck-$ExpectedVersion.txt" }
$results | ForEach-Object { "{0}`t{1}`t{2}" -f ($(if ($_.Ok) { "PASS" } else { "FAIL" })), $_.Name, $_.Detail } |
  Set-Content -Path $out -Encoding UTF8
Write-Host "report: $out"
if ($failed -ne 0) { exit 1 }
```

运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\check-kb.ps1 -Port 9646
```

> 端口以桌面端当前 Web 端口为准（每次启动可能变化）。  
> 期望最后一行：`RESULT: PASS (all checks)`。  
> 任何 `[FAIL]` 都把输出文件一并发回。

## 3. 功能复测（5 项）

使用测试库 `导入回归-20261101`，不要写真实库。

### A. kb_export 自动建父目录

让大模型执行：

```text
kb_export(kb="导入回归-20261101", format="md",
  out="E:\DeepSeek\project\commen\.kb-win-test\out\new-0352\验收导出.md")
```

要求：
- `out\new-0352\` 事先不存在；
- 导出成功，文件存在；
- 不再出现 `fatal load failure`，桌面端不重启。

### B. 目录批量导入（EPERM）

```text
kb_import(kb="导入回归-20261101",
  path="E:\DeepSeek\project\commen\.kb-win-test\batch-0351-stress\src")
```

要求：
- 8 个文件全部导入（或按重复规则明确跳过）；
- 不出现 `EPERM`、不整批中断。

### C. 重复/相似提示

依次导入：
- `batch-0351\src\隔离开关检修作业卡-0.35.1-副本.md`
- `batch-0351\src` 里由 docx 转出的同名 pdf

要求：
- 跳过行显示“与已有文档「…」重复”；
- 不再显示“正在导入中”；
- similar 段不再说“已照常导入”，而是按实际结果标 `已导入/已跳过/待导入`。

### D. 内容未变化重导

重复导入同一个 `.docx`（内容不变）。

要求：
- 显示“内容未变化，未新建版本（vN）”；
- 不增加版本号/文档数。

### E. 卡片颜色

打开 `/kb/` 总览页：

- 卡片库名圆点更亮；
- 底部可信度条为明亮绿/橙/红/蓝；
- 可截图：`kb-workbench-0.35.2.png`。

## 4. 测试库清理（可选）

`导入回归-20261101` 当前有 11 篇测试文档（4 文件批次 3 篇 + 8 文件批次 8 篇）。
确认无用后，让大模型按 docId 逐篇 `kb_remove`（默认软删除），**不要动其他库**。
如果需要保留基线，也可以不清理，但请在回报中说明。

## 5. 回报模板

```text
版本/commit：
自检脚本结果：PASS / FAIL（附 .txt）
A 导出父目录：PASS / FAIL
B 批量导入 EPERM：PASS / FAIL
C 重复/相似文案：PASS / FAIL
D 未变化重导：PASS / FAIL
E 卡片颜色：PASS / FAIL（附截图）
测试库是否已清理：
其他异常/截图：
```

## 6. 故障处理

- **自检失败在 version**：dsh-market 还没更新到 0.35.2；刷新/更新后重启，确认 commit 为 `c02d98d...`。
- **注册数不是 23 或有 FAIL**：同机可能还装着旧包 `dsh-knowledge-base`；移除旧包、重启，再跑自检。
- **导出仍 fatal**：确认版本是 0.35.2；保留 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\` 最新 crash 日志，不要反复重试。
- **仍偶发 EPERM**：插件已重试 3 次；若持续出现，记录源路径和 Defender/索引器状态，先单文件重试，不要关闭系统防护。
- **`tessdata=missing:chi_sim+eng`**：只是没有未压缩语言文件，OCR 仍可用，不是自检失败。
- **Windows 自托管 GitHub Actions job**：与普通使用无关，本清单不需要配置 runner。

## 7. 不需要做的事

- 不需要 npm 发布/登录（当前 GitHub-only）；
- 不需要改 `cordis.patch.yml` 的 loader id；现有配置不动；
- 不需要删除真实资料库；
- 不需要为了验收关闭 Defender。
