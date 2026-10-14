param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$CommandPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$utf8 = [Text.UTF8Encoding]::new($false)
$lastCommand = 0
$replacementDue = $null
$replacementProcess = $null
$replacementOutput = ''
$replacementError = ''
$replacementExitCode = $null
$verifyDue = $null
$replacementResult = $null

$form = [Windows.Forms.Form]::new()
$form.Text = 'OpenTalk - W23 Disposable Win32 Selection Target'
$form.ClientSize = [Drawing.Size]::new(720, 150)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$label = [Windows.Forms.Label]::new()
$label.Text = 'Disposable selected-text replacement target'
$label.Location = [Drawing.Point]::new(20, 18)
$label.AutoSize = $true
$form.Controls.Add($label)

$editor = [Windows.Forms.TextBox]::new()
$editor.Text = 'The controlled selected sentence.'
$editor.Location = [Drawing.Point]::new(20, 55)
$editor.Size = [Drawing.Size]::new(675, 30)
$editor.Font = [Drawing.Font]::new('Segoe UI', 12)
$form.Controls.Add($editor)

function Write-State {
    $state = @{
        ready = $form.Visible
        processId = $PID
        windowHandle = $form.Handle.ToInt64()
        editorHandle = $editor.Handle.ToInt64()
        focused = $editor.Focused
        selectionStart = $editor.SelectionStart
        selectionLength = $editor.SelectionLength
        text = $editor.Text
        replacementResult = $replacementResult
        commandSequence = $lastCommand
    } | ConvertTo-Json -Compress -Depth 6
    $temporary = "$StatePath.$PID.tmp"
    [IO.File]::WriteAllText($temporary, $state, $utf8)
    Move-Item -LiteralPath $temporary -Destination $StatePath -Force
}

function Select-Fixture {
    $form.Activate()
    $editor.Focus() | Out-Null
    $editor.SelectAll()
    Write-State
}

function Start-Replacement {
    Select-Fixture
    if ($script:replacementProcess -or $script:replacementDue) { return }
    $script:replacementResult = $null
    $script:replacementDue = [DateTime]::UtcNow.AddMilliseconds(300)
}

function Launch-Replacement {
    $testDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../native/helper/target/debug/deps'))
    $testBinary = Get-ChildItem -LiteralPath $testDirectory -Filter 'opentalk_helper-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (!$testBinary) { $script:replacementResult = @{ status = 'test-binary-missing' }; return }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $testBinary.FullName
    $start.Arguments = 'target::tests::controlled_native_edit_replacement --exact --ignored --nocapture'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['OPENTALK_W23_TARGET'] = '1'
    $start.EnvironmentVariables['OPENTALK_W23_TARGET_WINDOW'] = [string]$form.Handle.ToInt64()
    $start.EnvironmentVariables['OPENTALK_W23_TARGET_EDITOR'] = [string]$editor.Handle.ToInt64()
    $script:replacementProcess = [Diagnostics.Process]::Start($start)
    # Starting the hidden test host can transiently disturb Win32 activation.
    # Reassert the disposable editor from its own UI thread before the test samples it.
    Select-Fixture
}

$timer = [Windows.Forms.Timer]::new()
$timer.Interval = 100
$timer.Add_Tick({
    try {
        if ($script:replacementDue -and [DateTime]::UtcNow -ge $script:replacementDue) {
            $script:replacementDue = $null
            Launch-Replacement
        }
        if ($script:replacementProcess -and $script:replacementProcess.HasExited) {
            $script:replacementExitCode = $script:replacementProcess.ExitCode
            $script:replacementOutput = $script:replacementProcess.StandardOutput.ReadToEnd()
            $script:replacementError = $script:replacementProcess.StandardError.ReadToEnd()
            $script:replacementProcess.Dispose()
            $script:replacementProcess = $null
            $script:verifyDue = [DateTime]::UtcNow.AddMilliseconds(250)
        }
        if ($script:verifyDue -and [DateTime]::UtcNow -ge $script:verifyDue) {
            $script:verifyDue = $null
            $inserted = $editor.Text -eq 'W23 controlled replacement.'
            $script:replacementResult = @{
                status = if ($script:replacementExitCode -eq 0 -and $inserted) { 'passed' } else { 'failed' }
                exitCode = $script:replacementExitCode
                insertedExactly = $inserted
                output = $script:replacementOutput
                error = $script:replacementError
            }
        }
        if (Test-Path -LiteralPath $CommandPath) {
            $command = Get-Content -Raw -LiteralPath $CommandPath | ConvertFrom-Json
            if ([long]$command.sequence -gt $lastCommand) {
                $script:lastCommand = [long]$command.sequence
                switch ([string]$command.action) {
                    'select' { Select-Fixture }
                    'replace' { Start-Replacement }
                    'close' { $form.Close() }
                }
            }
        }
        Write-State
    } catch { Write-State }
})

$form.Add_Shown({ Select-Fixture; $timer.Start() })
$form.Add_FormClosed({ $timer.Stop(); Write-State })
[void][Windows.Forms.Application]::Run($form)
