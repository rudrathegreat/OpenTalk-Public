param(
    [Parameter(Mandatory = $true)]
    [string]$StatePath,
    [Parameter(Mandatory = $true)]
    [string]$CommandPath,
    [string]$ProbeBinaryPath = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class W23WindowProbe {
    public delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder value, int maximum);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public static object[] Candidates() {
        var candidates = new List<object>();
        EnumWindows((window, parameter) => {
            if (!IsWindowVisible(window)) return true;
            Rect rectangle; uint processId;
            if (!GetWindowRect(window, out rectangle)) return true;
            var width = rectangle.Right - rectangle.Left;
            var height = rectangle.Bottom - rectangle.Top;
            var className = new StringBuilder(128);
            GetClassName(window, className, className.Capacity);
            if (className.ToString() != "Chrome_WidgetWin_1" || width > 650 || height > 350) return true;
            GetWindowThreadProcessId(window, out processId);
            var point = new Point { X = rectangle.Left + width / 2, Y = rectangle.Top + height / 2 };
            var hit = WindowFromPoint(point);
            candidates.Add(new {
                handle = window.ToInt64(), processId, x = rectangle.Left, y = rectangle.Top, width, height,
                hit = hit.ToInt64(), hitRoot = GetAncestor(hit, 2).ToInt64(), hitRootOwner = GetAncestor(hit, 3).ToInt64()
            });
            return true;
        }, IntPtr.Zero);
        return candidates.ToArray();
    }
}
'@

$utf8 = [System.Text.UTF8Encoding]::new($false)
$lastCommand = 0
$writingState = $false
$probeSnapshots = @()
$probeProcess = $null
$windowSnapshots = @()
$windowProbeDue = $null
$replacementProcess = $null
$replacementResult = $null
$replacementDue = $null
$window = [System.Windows.Window]::new()
$window.Title = 'OpenTalk - W23 Disposable Selection Target'
$window.Width = 760
$window.Height = 250
$window.WindowStartupLocation = 'CenterScreen'
$window.Topmost = $true
$window.ResizeMode = 'NoResize'

$panel = [System.Windows.Controls.StackPanel]::new()
$panel.Margin = [System.Windows.Thickness]::new(24)
$window.Content = $panel

$heading = [System.Windows.Controls.TextBlock]::new()
$heading.Text = 'DISPOSABLE W23 SELECTION TARGET'
$heading.FontSize = 18
$heading.FontWeight = 'Bold'
$panel.Children.Add($heading) | Out-Null

$description = [System.Windows.Controls.TextBlock]::new()
$description.Text = 'Only the fixed synthetic sentence below is used. No private text is collected.'
$description.Margin = [System.Windows.Thickness]::new(0, 8, 0, 14)
$panel.Children.Add($description) | Out-Null

$editor = [System.Windows.Controls.TextBox]::new()
$editor.Name = 'W23SelectionTarget'
$editor.Text = 'The controlled selected sentence.'
$editor.FontSize = 16
$editor.Padding = [System.Windows.Thickness]::new(8)
$editor.Height = 44
$panel.Children.Add($editor) | Out-Null

$status = [System.Windows.Controls.TextBlock]::new()
$status.Text = 'The entire sentence should remain selected while the assistant is used.'
$status.Margin = [System.Windows.Thickness]::new(0, 12, 0, 0)
$panel.Children.Add($status) | Out-Null

function Write-State {
    if ($script:writingState) { return }
    $script:writingState = $true
    try {
        $handle = [System.Windows.Interop.WindowInteropHelper]::new($window).Handle.ToInt64()
        $state = @{
            ready = $window.IsVisible
            processId = $PID
            windowHandle = $handle
            focused = $editor.IsKeyboardFocused
            selectionStart = $editor.SelectionStart
            selectionLength = $editor.SelectionLength
            text = $editor.Text
            probeSnapshots = $probeSnapshots
            windowSnapshots = $windowSnapshots
            replacementResult = $replacementResult
            commandSequence = $lastCommand
        } | ConvertTo-Json -Compress -Depth 8
        $temporary = "$StatePath.$PID.tmp"
        [IO.File]::WriteAllText($temporary, $state, $utf8)
        Move-Item -LiteralPath $temporary -Destination $StatePath -Force
    } finally {
        $script:writingState = $false
    }
}

function Select-Fixture {
    $window.Activate() | Out-Null
    $editor.Focus() | Out-Null
    $editor.SelectAll()
    Write-State
}

function Start-SelectionProbe {
    Select-Fixture
    if ($script:probeProcess) { return }
    $probe = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'w23-selection-probe.mjs'))
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command node.exe).Source
    $start.Arguments = "`"$probe`""
    if ($ProbeBinaryPath) { $start.Arguments += " --binary=`"$ProbeBinaryPath`"" }
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $script:probeSnapshots = @()
    $script:probeProcess = [Diagnostics.Process]::Start($start)
}

function Complete-SelectionProbe {
    if (!$script:probeProcess -or !$script:probeProcess.HasExited) { return }
    try {
        $output = $script:probeProcess.StandardOutput.ReadToEnd()
        if ($script:probeProcess.ExitCode -ne 0) { throw "Selection probe exited with $($script:probeProcess.ExitCode)." }
        $script:probeSnapshots = $output | ConvertFrom-Json
    } catch {
        $script:probeSnapshots = @(@{ error = [string]$_.Exception.Message })
    } finally {
        $script:probeProcess.Dispose()
        $script:probeProcess = $null
        Write-State
    }
}

function Start-WindowProbe {
    Select-Fixture
    $script:windowSnapshots = @()
    $script:windowProbeDue = [DateTime]::UtcNow.AddSeconds(1)
}

function Complete-WindowProbe {
    if (!$script:windowProbeDue -or [DateTime]::UtcNow -lt $script:windowProbeDue) { return }
    $script:windowProbeDue = $null
    $script:windowSnapshots = @([W23WindowProbe]::Candidates())
    Write-State
}

function Start-ReplacementProbe {
    Select-Fixture
    if ($script:replacementProcess -or $script:replacementDue) { return }
    $script:replacementResult = $null
    $script:replacementDue = [DateTime]::UtcNow.AddMilliseconds(300)
}

function Complete-ReplacementProbe {
    if ($script:replacementDue -and [DateTime]::UtcNow -ge $script:replacementDue) {
        $script:replacementDue = $null
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
    $start.EnvironmentVariables['OPENTALK_W23_TARGET_WINDOW'] = [string][System.Windows.Interop.WindowInteropHelper]::new($window).Handle.ToInt64()
    $script:replacementProcess = [Diagnostics.Process]::Start($start)
    }
    if (!$script:replacementProcess -or !$script:replacementProcess.HasExited) { return }
    $exitCode = $script:replacementProcess.ExitCode
    $output = $script:replacementProcess.StandardOutput.ReadToEnd()
    $errorOutput = $script:replacementProcess.StandardError.ReadToEnd()
    $script:replacementProcess.Dispose()
    $script:replacementProcess = $null
    $script:replacementResult = @{
        status = if ($exitCode -eq 0 -and $editor.Text -eq 'W23 controlled replacement.') { 'passed' } else { 'failed' }
        exitCode = $exitCode
        insertedExactly = $editor.Text -eq 'W23 controlled replacement.'
        output = $output
        error = $errorOutput
    }
    Write-State
}

$timer = [System.Windows.Threading.DispatcherTimer]::new()
$timer.Interval = [TimeSpan]::FromMilliseconds(100)
$timer.Add_Tick({
    try {
        Complete-SelectionProbe
        Complete-WindowProbe
        Complete-ReplacementProbe
        if (Test-Path -LiteralPath $CommandPath) {
            $command = Get-Content -Raw -LiteralPath $CommandPath | ConvertFrom-Json
            $sequence = [long]$command.sequence
            if ($sequence -gt $lastCommand) {
                $script:lastCommand = $sequence
                switch ([string]$command.action) {
                    'select' { Select-Fixture }
                    'probe' { Start-SelectionProbe }
                    'windows' { Start-WindowProbe }
                    'replace' { Start-ReplacementProbe }
                    'close' { $window.Close() }
                }
            }
        }
        Write-State
    } catch { Write-State }
})

$window.Add_ContentRendered({ $timer.Start(); Select-Fixture })
$window.Add_Closed({ $timer.Stop(); Write-State })
[void]$window.ShowDialog()
