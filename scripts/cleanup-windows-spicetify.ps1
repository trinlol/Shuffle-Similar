# Removes duplicate Shuffle Similar / Better Shuffle extension installs on Windows.
$ErrorActionPreference = "Stop"

$spicetifyRoot = Join-Path $env:APPDATA "spicetify"
$extensionsDir = Join-Path $spicetifyRoot "Extensions"
$configPath = Join-Path $spicetifyRoot "config.ini"
$keepFile = "shuffle-similar.js"
$legacyFiles = @("better-shuffle.js", "similar-shuffle.js")

Write-Host "=== Shuffle Similar cleanup ==="
Write-Host "Spicetify root: $spicetifyRoot`n"

if (-not (Test-Path $extensionsDir)) {
  Write-Error "Extensions folder not found: $extensionsDir"
}

Write-Host "All extension .js files:"
$allJs = Get-ChildItem $extensionsDir -Filter "*.js"
if ($allJs.Count -eq 0) {
  Write-Host "  (none)"
} else {
  $allJs | ForEach-Object { Write-Host "  $($_.Name)" }
}

Write-Host "`nShuffle-related files:"
$shuffleJs = $allJs | Where-Object { $_.Name -match "shuffle" }
$shuffleJs | ForEach-Object { Write-Host "  $($_.Name)" }

$removed = @()
foreach ($legacy in $legacyFiles) {
  $path = Join-Path $extensionsDir $legacy
  if (Test-Path $path) {
    Remove-Item $path -Force
    $removed += $legacy
    Write-Host "`nRemoved: $path"
  }
}

if (-not (Test-Path (Join-Path $extensionsDir $keepFile))) {
  Write-Warning "`n$keepFile not found. Download from: https://github.com/trinlol/Shuffle-Similar/releases/latest"
}

if (-not (Test-Path $configPath)) {
  Write-Warning "config.ini not found: $configPath"
} else {
  Write-Host "`nCurrent config.ini extensions line:"
  Select-String -Path $configPath -Pattern '^\s*extensions\s*=' | ForEach-Object { Write-Host "  $($_.Line)" }

  $lines = Get-Content $configPath
  $updated = $false
  $newLines = foreach ($line in $lines) {
    if ($line -match '^\s*extensions\s*=\s*(.+)$') {
      $entries = $Matches[1] -split '\s*\|\s*' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
      $legacyEntries = $entries | Where-Object {
        $_ -match 'better-shuffle' -or $_ -match 'similar-shuffle' -or ($_ -match 'shuffle' -and $_ -ne $keepFile)
      }
      $otherEntries = $entries | Where-Object {
        $_ -notmatch 'better-shuffle' -and $_ -notmatch 'similar-shuffle' -and -not ($_ -match 'shuffle' -and $_ -ne $keepFile)
      }

      if ($legacyEntries.Count -gt 0) {
        Write-Host "`nRemoving from config:"
        $legacyEntries | ForEach-Object { Write-Host "  $_" }
      }

      $next = @($otherEntries)
      if (Test-Path (Join-Path $extensionsDir $keepFile)) {
        $next += $keepFile
      }

      $next = $next | Select-Object -Unique
      $updated = $true
      "extensions = $($next -join ' | ')"
    } else {
      $line
    }
  }

  if ($updated) {
    Set-Content -Path $configPath -Value $newLines -Encoding UTF8
    Write-Host "`nUpdated config.ini"
    Select-String -Path $configPath -Pattern '^\s*extensions\s*=' | ForEach-Object { Write-Host "  $($_.Line)" }
  }
}

if (Get-Command spicetify -ErrorAction SilentlyContinue) {
  Write-Host "`nRunning: spicetify apply"
  spicetify apply
} else {
  Write-Warning "`nspicetify CLI not in PATH. Run 'spicetify apply' manually, then restart Spotify."
}

Write-Host "`n=== Done ==="
if ($removed.Count -gt 0) {
  Write-Host "Deleted: $($removed -join ', ')"
} else {
  Write-Host "No legacy .js files found on disk."
}
Write-Host "If you still see duplicates, uninstall Better Shuffle / Similar Shuffle from Spicetify Marketplace too."
