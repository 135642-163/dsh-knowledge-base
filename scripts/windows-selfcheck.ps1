param(
  [Parameter(Mandatory = $true)][int]$Port,
  [string]$ExpectedVersion = "0.37.0",
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
  Check "GET /kb/ html" ($html.StatusCode -eq 200 -and $html.Content.Length -gt 100) "bytes=$($html.Content.Length)"
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
  $row = $null
  if ($updates.packages) {
    $row = @($updates.packages | Where-Object { $_.name -eq "dsh-knowledge-wiki" })[0]
  } elseif ($updates.updates) {
    $entry = $updates.updates.'dsh-knowledge-wiki'
    if ($entry) {
      $row = [pscustomobject]@{ current = $entry.current; updateAvailable = $entry.updateAvailable }
    }
  }
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
