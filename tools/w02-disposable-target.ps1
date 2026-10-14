param(
    [Parameter(Mandatory = $true)]
    [string]$StatePath,
    [Parameter(Mandatory = $true)]
    [string]$CommandPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class W02NativeWindow {
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr window);
}
'@

$utf8 = [System.Text.UTF8Encoding]::new($false)
$lastCommand = 0
$writingState = $false

$form = [System.Windows.Forms.Form]::new()
$form.Text = 'OpenTalk - W02 Disposable Target'
$form.ClientSize = [System.Drawing.Size]::new(700, 300)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$heading = [System.Windows.Forms.Label]::new()
$heading.Text = 'DISPOSABLE W02 TEST TARGET'
$heading.Font = [System.Drawing.Font]::new('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$heading.Location = [System.Drawing.Point]::new(24, 20)
$heading.AutoSize = $true
$form.Controls.Add($heading)

$description = [System.Windows.Forms.Label]::new()
$description.Text = 'Both fields are blank, local, and ordinary privilege. Do not type real content here.'
$description.Font = [System.Drawing.Font]::new('Segoe UI', 10)
$description.Location = [System.Drawing.Point]::new(26, 58)
$description.AutoSize = $true
$form.Controls.Add($description)

$primaryLabel = [System.Windows.Forms.Label]::new()
$primaryLabel.Text = 'Controlled insertion field'
$primaryLabel.Location = [System.Drawing.Point]::new(26, 94)
$primaryLabel.AutoSize = $true
$form.Controls.Add($primaryLabel)

$primary = [System.Windows.Forms.TextBox]::new()
$primary.Name = 'W02PrimaryInput'
$primary.AccessibleName = 'W02 controlled insertion field'
$primary.Location = [System.Drawing.Point]::new(28, 116)
$primary.Size = [System.Drawing.Size]::new(642, 30)
$primary.Font = [System.Drawing.Font]::new('Segoe UI', 11)
$form.Controls.Add($primary)

$secondaryLabel = [System.Windows.Forms.Label]::new()
$secondaryLabel.Text = 'Controlled focus-change field'
$secondaryLabel.Location = [System.Drawing.Point]::new(26, 164)
$secondaryLabel.AutoSize = $true
$form.Controls.Add($secondaryLabel)

$secondary = [System.Windows.Forms.TextBox]::new()
$secondary.Name = 'W02SecondaryInput'
$secondary.AccessibleName = 'W02 controlled focus-change field'
$secondary.Location = [System.Drawing.Point]::new(28, 186)
$secondary.Size = [System.Drawing.Size]::new(642, 30)
$secondary.Font = [System.Drawing.Font]::new('Segoe UI', 11)
$form.Controls.Add($secondary)

$footer = [System.Windows.Forms.Label]::new()
$footer.Text = 'This window closes after each opt-in check. No text is retained outside its disposable runtime folder.'
$footer.Location = [System.Drawing.Point]::new(26, 242)
$footer.AutoSize = $true
$form.Controls.Add($footer)

function Write-State {
    if ($script:writingState) { return }
    $script:writingState = $true
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    $state = @{
        ready = $form.Visible
        elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        processId = $PID
        active = if ($primary.Focused) { 'primary' } elseif ($secondary.Focused) { 'secondary' } else { 'none' }
        primary = $primary.Text
        secondary = $secondary.Text
        commandSequence = $lastCommand
    } | ConvertTo-Json -Compress
    $temporary = "$StatePath.$PID.tmp"
    try {
        [IO.File]::WriteAllText($temporary, $state, $utf8)
        for ($attempt = 0; $attempt -lt 5; $attempt++) {
            try {
                Move-Item -LiteralPath $temporary -Destination $StatePath -Force
                return
            } catch {
                if ($attempt -eq 4) { return }
                Start-Sleep -Milliseconds 20
            }
        }
    } finally {
        $script:writingState = $false
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
}

function Focus-Field([System.Windows.Forms.TextBox]$field) {
    $form.Activate()
    $form.BringToFront()
    [void]$field.Focus()
    $field.SelectionStart = $field.TextLength
    $field.SelectionLength = 0
}

$primary.Add_TextChanged({ Write-State })
$secondary.Add_TextChanged({ Write-State })
$primary.Add_Enter({ Write-State })
$secondary.Add_Enter({ Write-State })

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 75
$timer.Add_Tick({
    try {
        if (Test-Path -LiteralPath $CommandPath) {
            $command = Get-Content -Raw -LiteralPath $CommandPath | ConvertFrom-Json
            if ($command.sequence -is [long] -or $command.sequence -is [int]) {
                $sequence = [long]$command.sequence
                if ($sequence -gt $lastCommand) {
                    $lastCommand = $sequence
                    switch ([string]$command.action) {
                        'clear-primary' { $primary.Clear(); Focus-Field $primary }
                        'focus-primary' { Focus-Field $primary }
                        'focus-secondary' { Focus-Field $secondary }
                        'close' { $form.Close() }
                    }
                    Write-State
                }
            }
        }
        Write-State
    } catch { Write-State }
})

$form.Add_Shown({
    [void][W02NativeWindow]::ShowWindow($form.Handle, 5)
    [void][W02NativeWindow]::SetForegroundWindow($form.Handle)
    $timer.Start()
    Focus-Field $primary
    Write-State
})
$form.Add_FormClosed({
    $timer.Stop()
    try {
        $state = @{
            ready = $false
            elevated = $false
            processId = $PID
            active = 'none'
            primary = $primary.Text
            secondary = $secondary.Text
            commandSequence = $lastCommand
        } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($StatePath, $state, $utf8)
    } catch {}
})

[void]$form.ShowDialog()
