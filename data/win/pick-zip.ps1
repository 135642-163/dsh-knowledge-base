# Pick a local .zip knowledge-base package via the Windows file dialog.
# Called by dsh-knowledge-base (lib/web/file-picker.js) on Windows.
# Exit code 0 = picked or canceled; stdout contains the absolute path when picked.
param(
  [string]$Title = "Select knowledge base package (.zip)"
)

$ErrorActionPreference = 'Stop'
# Force UTF-8 output so the Node caller can read non-ASCII paths reliably.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $Title
$dialog.Filter = 'Knowledge base package (*.zip)|*.zip|All files (*.*)|*.*'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true

if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.FileName)
}
