param(
  [string]$OutputZip = 'uls-turizm-operasyon-source-backup-restored.zip'
)
$parts = Get-ChildItem -Path $PSScriptRoot -Filter '*.b64' | Sort-Object Name
if(-not $parts){ throw 'Parca dosyalari bulunamadi.' }
$joined = ($parts | ForEach-Object { Get-Content $_.FullName -Raw }) -join ''
[IO.File]::WriteAllBytes((Join-Path $PSScriptRoot $OutputZip), [Convert]::FromBase64String($joined))
Write-Host ('Restore tamamlandi: ' + (Join-Path $PSScriptRoot $OutputZip))
