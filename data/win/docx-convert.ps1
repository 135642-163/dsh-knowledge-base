# Convert a legacy .doc (or any file Word can open) to .docx via Word COM automation.
# Called by dsh-knowledge-base (lib/parsers.js convertLegacyDocToBuffer) on Windows.
#
# Usage: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File docx-convert.ps1 -Source <in> -Dest <out.docx>
# Exit code 0 = success; non-zero = failure (message on stderr).
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Dest
)

$ErrorActionPreference = 'Stop'
# Force UTF-8 output so the Node caller can read Chinese error text reliably.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0                     # wdAlertsNone: suppress every dialog
  try { $word.AutomationSecurity = 3 } catch {}  # msoAutomationSecurityForceDisable: block macros
  try { $word.Options.SaveInterval = 0 } catch {}

  # Open read-only, no format-confirmation prompt (ConfirmConversions=false, ReadOnly=true).
  $doc = $word.Documents.Open($Source, $false, $true)
  # 16 = wdFormatXMLDocument (.docx)
  try {
    $doc.SaveAs2($Dest, 16)
  } catch {
    $doc.SaveAs($Dest, 16)
  }
  $doc.Close($false)
  $doc = $null
} finally {
  if ($null -ne $doc) { try { $doc.Close($false) } catch {} }
  if ($null -ne $word) {
    try { $word.Quit() } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) } catch {}
  }
}
