$base64Path = Join-Path $PSScriptRoot 'source-backup.zip.base64'
$zipPath = Join-Path $PSScriptRoot 'uls-turizm-operasyon-source-backup-20260509-gnc.zip'
$base64 = Get-Content -Raw -LiteralPath $base64Path
[IO.File]::WriteAllBytes($zipPath, [Convert]::FromBase64String($base64))
Write-Host "Backup zip olusturuldu: $zipPath"
