# OpenTalk

OpenTalk is a local-first Windows desktop app for dictation, meeting capture, selected-text assistance, and deterministic voice commands. Speech recognition runs on the local machine. Optional text cleanup and summarization use the selected ChatGPT account through OpenAI's documented Sign in with ChatGPT preview flow.

> [!WARNING]
> OpenTalk is a working Windows x64 preview. It is unsigned, has not completed broad application-compatibility testing, and is not ready for general distribution.

## Features

- Hold-to-talk dictation with a guarded, at-most-once paste into the field that was focused when recording began.
- CPU-only local transcription with Moonshine Small Streaming by default and optional Whisper models.
- Five cleanup styles: Default, Minimal, Casual, Professional, and Extensive.
- Selected-text Assistant with explicit Replace or Add actions.
- Meeting and lecture capture from the selected microphone and, only during an active meeting, a user-selected Windows playback endpoint.
- Deterministic local voice commands for a fixed, reviewed command catalog.
- An OpenTalk hub with encrypted local dictation history, meeting records, overview statistics, and bounded task extraction.
- Explicit cancellation and failure handling. OpenTalk does not synthesize Enter or execute dictated free-form instructions.

## Privacy and security model

- Microphone and playback audio are transcribed locally and are not sent to the text provider.
- Cloud-backed text features send only the bounded text required for the action the user started. They do not send surrounding document contents, screenshots, clipboard history, or arbitrary keystrokes.
- Account credentials remain in the Electron main process and are protected with Windows-backed storage. They are not stored in this repository or exposed to the renderer or native workers.
- Local history uses Windows account protection. Raw audio and intermediate transcripts are temporary and are removed on terminal session paths; this is not a forensic secure-erasure guarantee.
- Model downloads are pinned by URL, size, and SHA-256 digest. Model weights and generated binaries are deliberately excluded from source control.
- The renderer is sandboxed and context-isolated, with a narrow preload API, restrictive content policy, navigation blocking, and runtime validation at IPC boundaries.

See [REQUIREMENTS.md](REQUIREMENTS.md) for product behavior and [ARCHITECTURE.md](ARCHITECTURE.md) for trust boundaries and lifecycle details.

## Current status

The core controlled path has been exercised on Windows: explicit microphone capture, local transcription, completed account-authorized cleanup, target revalidation, and one guarded insertion. Cancellation, focus change, and a controlled worker failure produced no insertion in those checks.

That evidence is intentionally narrow. The project still requires clean-machine installation and removal testing, code signing, broader application compatibility, accessibility review, long-session validation, and a complete release audit. Recent meeting, Assistant, task, and presentation changes also need attended acceptance before a public binary release.

## Repository layout

```text
apps/desktop/          Electron main process, preload, and React renderer
packages/core/         Session, account, storage, cleanup, and feature logic
native/helper/         Rust Windows capture, hotkey, focus, and insertion helper
native/worker/         C++ local speech-recognition worker
native/moonshine/      Pinned model manifest only; no model weights
tests/                 Offline and mocked TypeScript tests
tools/                 Build, packaging, smoke-test, and verification scripts
docs/technical-brief/  Public technical overview and source ledger
```

Generated files, dependencies, runtime profiles, downloaded toolchains, model weights, native binaries, and installers are ignored and are not part of the repository.

## Prerequisites

- Windows 11 x64
- Node.js 24.x and npm
- Git
- Rustup with the pinned Rust 1.98.1 toolchain
- Visual Studio Build Tools with the Desktop development with C++ workload
- PowerShell and `curl.exe`

The native build currently expects Rust and the pinned `whisper.cpp` checkout under the repository-local ignored `.tools/` directory.

## Development setup

From PowerShell in the repository root:

```powershell
npm ci

$env:RUSTUP_HOME = Join-Path $PWD '.tools\rustup'
$env:CARGO_HOME = Join-Path $PWD '.tools\cargo'
rustup toolchain install 1.98.1
rustup default 1.98.1

New-Item -ItemType Directory -Force .tools | Out-Null
git clone https://github.com/ggml-org/whisper.cpp .tools/whisper.cpp
git -C .tools/whisper.cpp checkout 927cfce34f31707e17f2bff35c349632fb9e2c3a

npm run native:build
npm start
```

`native:build` verifies the pinned `whisper.cpp` revision, applies the reviewed cancellation patch, and downloads checksum-pinned Moonshine runtime and model assets. These downloads are local build inputs and must not be committed.

Inside the app, use **Continue with ChatGPT** to connect an eligible account. This integration is a preview and account eligibility, plan limits, and model access can change. OpenTalk does not accept an API key and does not silently switch to separately billed API usage.

## Checks

Run the offline TypeScript, lint, build, and unit-test suite:

```powershell
npm run check
```

Run the default native tests after the repository-local Rust setup:

```powershell
npm run native:test
```

Hardware, live-account, microphone, playback, insertion, and packaging checks are intentionally opt-in. Review the relevant script before running it; some checks capture real devices, consume ChatGPT plan usage, or interact with a disposable test window.

To create an unsigned local preview installer after the checks and native build:

```powershell
npm run package:win
```

Do not publish that artifact as a supported release without completing the outstanding distribution gates in [TASKS.md](TASKS.md).

## Contributing

Read [AGENTS.md](AGENTS.md) before changing the code. Keep TypeScript strict, preserve the one-attempt insertion invariant, validate all external input at runtime, and add meaningful coverage for changed behavior. Never commit credentials, account data, private recordings, generated profiles, downloaded models, build output, or installer artifacts.

If a security report could expose credentials or private user data, do not include the sensitive value in a public issue. Use the repository host's private vulnerability-reporting channel when available.

## Documentation

- [Requirements](REQUIREMENTS.md)
- [Architecture](ARCHITECTURE.md)
- [Current task queue](TASKS.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Technical brief](docs/technical-brief/TECHNICAL_BRIEF.md)

## License

OpenTalk source is available under the [GNU General Public License v3.0](LICENSE). Third-party components and model assets remain subject to their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
