$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeRoot = Join-Path $projectRoot '.tools/moonshine-0.1.5'
New-Item -ItemType Directory -Force $runtimeRoot | Out-Null
function VerifiedAsset([string]$url, [string]$target, [string]$hash) {
  if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -eq $hash) { return }
  $temporary = "$target.partial"
  & curl.exe --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 1800 --output $temporary $url
  if ($LASTEXITCODE -ne 0) { throw 'Moonshine asset download failed.' }
  if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Moonshine asset checksum mismatch.' }
  Move-Item -LiteralPath $temporary -Destination $target -Force
}
VerifiedAsset 'https://files.pythonhosted.org/packages/ea/05/ad3457baa56170a13829c98327598a4d99d6cd4bdff8ae59df4c47ebdd11/moonshine_voice-0.1.5-py3-none-win_amd64.whl' (Join-Path $runtimeRoot 'runtime.zip') '7fc9a84e827360ddb85c2735f44a1502c5575c27dcb476a2555646cd20a70e9d'
Expand-Archive -LiteralPath (Join-Path $runtimeRoot 'runtime.zip') -DestinationPath (Join-Path $runtimeRoot 'wheel') -Force
VerifiedAsset 'https://raw.githubusercontent.com/moonshine-ai/moonshine/234f60faa0eb388b01cdf7e60aca232af37aefda/core/moonshine-c-api.h' (Join-Path $runtimeRoot 'moonshine-c-api.h') 'e5c9038c4987d87f40abd78f843bd6ab0bff96a5ffd1cc2557c5531b0cbab21f'
VerifiedAsset 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.23.2/LICENSE' (Join-Path $runtimeRoot 'onnxruntime-LICENSE.txt') '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c'
VerifiedAsset 'https://raw.githubusercontent.com/microsoft/onnxruntime/v1.23.2/ThirdPartyNotices.txt' (Join-Path $runtimeRoot 'onnxruntime-NOTICES.txt') 'e9e90971a8e75a9a8ac0c6412e29c1202d079998389915aa485f46c816c3b4cc'
$includeRoot = Join-Path $runtimeRoot 'include'
New-Item -ItemType Directory -Force $includeRoot | Out-Null
# Mechanical consumer-header adaptation only: do not export the library's symbols from our executable.
$consumerHeader = (Get-Content -LiteralPath (Join-Path $runtimeRoot 'moonshine-c-api.h') -Raw).Replace('__declspec(dllexport)', '__declspec(dllimport)')
[IO.File]::WriteAllText((Join-Path $includeRoot 'moonshine-c-api.h'), $consumerHeader, [Text.UTF8Encoding]::new($false))
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'native/moonshine/manifest.json') -Raw | ConvertFrom-Json
$modelRoot = Join-Path $projectRoot '.tools/moonshine-small-streaming-en'
New-Item -ItemType Directory -Force $modelRoot | Out-Null
foreach ($asset in $manifest.files) { VerifiedAsset "$($manifest.url)/$($asset.name)" (Join-Path $modelRoot $asset.name) $asset.sha256 }
