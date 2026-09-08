$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$distPath = Join-Path $projectRoot 'dist'
$artifacts = @(
  (Join-Path $distPath "Nexus-Game-Launcher-Setup-$version.exe"),
  (Join-Path $distPath "Nexus-Game-Launcher-Portable-$version.exe"),
  (Join-Path $distPath 'win-unpacked\Nexus Game Launcher.exe')
)

foreach ($artifact in $artifacts) {
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Expected artifact was not found: $artifact"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $artifact
  if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
    throw "Invalid Authenticode signature on $artifact (status: $($signature.Status))."
  }

  Write-Output "Valid signature: $([System.IO.Path]::GetFileName($artifact)) - $($signature.SignerCertificate.Subject)"
}

Write-Output 'Every public executable has a valid Authenticode signature.'
