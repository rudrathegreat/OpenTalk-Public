param([Parameter(Mandatory = $true)][string]$OutputRoot)
$ErrorActionPreference = 'Stop'
# Generates local test audio, never plays it and never opens a microphone.
$runtimeRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.runtime'))
$fixtureRoot = [IO.Path]::GetFullPath($OutputRoot)
if ([IO.Path]::GetDirectoryName($fixtureRoot) -ne $runtimeRoot -or [IO.Path]::GetFileName($fixtureRoot) -notmatch '^cpu200-[0-9a-f-]+$') {
    throw 'Synthetic fixtures must be inside the explicitly generated workspace runtime directory.'
}
Add-Type -AssemblyName System.Speech
$synth = [System.Speech.Synthesis.SpeechSynthesizer]::new()
try {
    $voice = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'en' }) | Select-Object -First 1
    if (!$voice) { throw 'An installed English Windows speech-synthesis voice is required.' }
    $synth.SelectVoice($voice.VoiceInfo.Name)
    $format = [System.Speech.AudioFormat.SpeechAudioFormatInfo]::new(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $clips = @(
        @{ name = 'short'; text = 'Please send the revised invoice on Thursday, not Friday, and keep the total below one hundred dollars.' },
        @{ name = 'ten-seconds'; text = 'Please send the revised invoice to Acme on Thursday, not Friday. The delivery must remain confidential, and the total must stay below one hundred dollars. Do not change the billing address.' },
        @{ name = 'twenty-seconds'; text = 'Please send the revised invoice to Acme on Thursday, not Friday. The delivery must remain confidential, and the total must stay below one hundred dollars. Do not change the billing address. First, confirm that the new date is available. Second, ask the team to check the amount. Finally, keep the previous reference number because the customer has already approved it.' },
        @{ name = 'near-thirty-seconds'; text = 'Please send the revised invoice to Acme on Thursday, not Friday. The delivery must remain confidential, and the total must stay below one hundred dollars. Do not change the billing address. First, confirm that the new date is available. Second, ask the team to check the amount. Finally, keep the previous reference number because the customer has already approved it. We still need the report before lunch, but do not include the draft figures. The final delivery date is Thursday, not Friday.' }
    )
    $metadata = @()
    foreach ($clip in $clips) {
        $path = Join-Path $fixtureRoot ($clip.name + '.wav')
        $words = ($clip.text -split '\s+').Count
        $bestRate = 0; $bestDistance = [double]::PositiveInfinity; $bestSeconds = 0
        foreach ($rate in 0..6) {
            $synth.Rate = $rate
            $synth.SetOutputToWaveFile($path, $format); $synth.Speak($clip.text); $synth.SetOutputToNull()
            $wave = [IO.File]::ReadAllBytes($path); $seconds = 0
            for ($position = 12; $position + 8 -le $wave.Length;) {
                $size = [BitConverter]::ToUInt32($wave, $position + 4)
                if ([Text.Encoding]::ASCII.GetString($wave, $position, 4) -eq 'data') { $seconds = $size / 32000.0 }
                $position += 8 + $size + ($size % 2)
            }
            if ($seconds -le 0) { throw 'Synthetic WAV has no valid PCM payload.' }
            $wpm = $words * 60.0 / $seconds
            $distance = [Math]::Abs($wpm - 200)
            if ($distance -lt $bestDistance) { $bestDistance = $distance; $bestRate = $rate; $bestSeconds = $seconds }
            if ($wpm -ge 195 -and $wpm -le 205) { break }
        }
        $synth.Rate = $bestRate
        $synth.SetOutputToWaveFile($path, $format); $synth.Speak($clip.text); $synth.SetOutputToNull()
        $metadata += @{ name = $clip.name; words = $words; seconds = [Math]::Round($bestSeconds, 3); wordsPerMinute = [Math]::Round($words * 60.0 / $bestSeconds, 1); rate = $bestRate }
    }
    ConvertTo-Json -InputObject $metadata -Depth 3 -Compress
} finally { $synth.Dispose() }
