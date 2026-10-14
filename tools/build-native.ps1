param([switch]$Test, [switch]$Fixture)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $projectRoot
$env:RUSTUP_HOME = Join-Path $projectRoot '.tools/rustup'
$env:CARGO_HOME = Join-Path $projectRoot '.tools/cargo'
$cargo = Join-Path $env:CARGO_HOME 'bin/cargo.exe'
if (!(Test-Path -LiteralPath $cargo)) { throw 'Workspace Rust is missing. Follow README setup.' }
$vswhere = 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe'
$buildTools = & $vswhere -latest -products '*' -property installationPath
if (!$buildTools) { throw 'MSVC Build Tools are required.' }
$devShell = Join-Path $buildTools 'Common7/Tools/Launch-VsDevShell.ps1'
& $devShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
if ($Fixture -and !$Test) { throw 'Use -Test -Fixture for the opt-in public-fixture pipeline test.' }
if ($Test) {
  if ($Fixture) { & $cargo test --locked --manifest-path native/helper/Cargo.toml public_fixture_final_drain -- --ignored --nocapture }
  else { & $cargo test --locked --manifest-path native/helper/Cargo.toml }
  if ($LASTEXITCODE -ne 0) { throw 'Native tests failed.' }; exit
}
& $cargo build --release --locked --manifest-path native/helper/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw 'Rust build failed.' }
$whisperSource = Join-Path $projectRoot '.tools/whisper.cpp'
$revision = & git -c "safe.directory=$($whisperSource.Replace('\','/'))" -C $whisperSource rev-parse HEAD
if ($revision -ne '927cfce34f31707e17f2bff35c349632fb9e2c3a') { throw 'whisper.cpp source revision mismatch.' }
$abortPatch = Join-Path $projectRoot 'native/worker/whisper-abort.patch'
# Reviewed local patch on the pinned revision: CPU graph cancellation only, no weight/quality change.
$patchPreference = $ErrorActionPreference
try {
  # Windows PowerShell otherwise treats expected native stderr on a fresh source tree as terminating.
  $ErrorActionPreference = 'Continue'
  & git -c "safe.directory=$($whisperSource.Replace('\','/'))" -C $whisperSource apply --reverse --check --ignore-space-change $abortPatch 2>$null
  $patchPresent = $LASTEXITCODE -eq 0
} finally { $ErrorActionPreference = $patchPreference }
if (!$patchPresent) {
  & git -c "safe.directory=$($whisperSource.Replace('\','/'))" -C $whisperSource apply --check --ignore-space-change $abortPatch
  if ($LASTEXITCODE -ne 0) { throw 'Pinned whisper cancellation patch does not apply cleanly.' }
  & git -c "safe.directory=$($whisperSource.Replace('\','/'))" -C $whisperSource apply --ignore-space-change $abortPatch
  if ($LASTEXITCODE -ne 0) { throw 'Whisper cancellation patch failed.' }
}
$cmake = Join-Path $buildTools 'Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe'
& (Join-Path $PSScriptRoot 'prepare-moonshine.ps1')
if (!$?) { throw 'Moonshine preparation failed.' }
& $cmake -S native/worker -B .tools/worker-build -G Ninja "-DWHISPER_SOURCE=$whisperSource" "-DMOONSHINE_INCLUDE=$projectRoot/.tools/moonshine-0.1.5/include" -DCMAKE_BUILD_TYPE=Release
if ($LASTEXITCODE -ne 0) { throw 'Worker configure failed.' }
& $cmake --build .tools/worker-build --parallel 6
if ($LASTEXITCODE -ne 0) { throw 'Worker build failed.' }
New-Item -ItemType Directory -Force native/bin | Out-Null
Copy-Item -LiteralPath native/helper/target/release/opentalk-helper.exe -Destination native/bin/opentalk-helper.exe
Copy-Item -LiteralPath .tools/worker-build/opentalk-worker.exe -Destination native/bin/opentalk-worker.exe
Copy-Item -LiteralPath .tools/whisper.cpp/LICENSE -Destination native/bin/whisper-LICENSE.txt
Copy-Item -LiteralPath .tools/moonshine-0.1.5/wheel/moonshine_voice/moonshine.dll -Destination native/bin/moonshine.dll
Copy-Item -LiteralPath .tools/moonshine-0.1.5/wheel/moonshine_voice/onnxruntime.dll -Destination native/bin/onnxruntime.dll
Copy-Item -LiteralPath .tools/moonshine-0.1.5/wheel/moonshine_voice-0.1.5.dist-info/licenses/LICENSE -Destination native/bin/moonshine-LICENSE.txt
Copy-Item -LiteralPath .tools/moonshine-0.1.5/onnxruntime-LICENSE.txt -Destination native/bin/onnxruntime-LICENSE.txt
Copy-Item -LiteralPath .tools/moonshine-0.1.5/onnxruntime-NOTICES.txt -Destination native/bin/onnxruntime-NOTICES.txt
# Official MSVC app-local redistributables, not a prerequisite installation or developer runtime.
$crt = Get-ChildItem -LiteralPath (Join-Path $buildTools 'VC/Redist/MSVC') -Recurse -Filter msvcp140.dll | Where-Object FullName -Match 'x64[\\/]Microsoft\.VC\d+\.CRT[\\/]msvcp140\.dll$' | Sort-Object FullName -Descending | Select-Object -First 1
if (!$crt) { throw 'Official x64 MSVC app-local redistributables missing.' }
foreach ($name in @('msvcp140.dll','msvcp140_1.dll','vcruntime140.dll','vcruntime140_1.dll')) {
  $dll = Join-Path $crt.DirectoryName $name
  if ((Get-AuthenticodeSignature -LiteralPath $dll).Status -ne 'Valid') { throw 'MSVC redistributable signature invalid.' }
  Copy-Item -LiteralPath $dll -Destination (Join-Path $projectRoot "native/bin/$name")
}
