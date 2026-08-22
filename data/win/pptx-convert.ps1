# Convert a legacy .ppt to .pptx via PowerPoint COM automation.
# Called by dsh-knowledge-base (lib/parsers.js convertLegacyPptToBuffer) on Windows.
#
# Usage: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File pptx-convert.ps1 -Source <in> -Dest <out.pptx>
# Exit code 0 = success; non-zero = failure (message on stderr).
#
# NOTE: keep this file ASCII-only (or UTF-8 with BOM). Windows PowerShell 5.1
# misreads BOM-less UTF-8 as ANSI and breaks on non-ASCII comments.
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Dest
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$app = $null
$pres = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  # ReadOnly=msoTrue(-1), Untitled=msoFalse(0), WithWindow=msoFalse(0).
  # MsoTriState must be passed as integers; booleans break the COM call.
  $pres = $app.Presentations.Open($Source, -1, 0, 0)
  # 24 = ppSaveAsOpenXMLPresentation (.pptx)
  $pres.SaveAs($Dest, 24)
  $pres.Close()
  $pres = $null
} finally {
  if ($null -ne $pres) { try { $pres.Close() } catch {} }
  if ($null -ne $app) {
    try { $app.Quit() } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) } catch {}
  }
}
