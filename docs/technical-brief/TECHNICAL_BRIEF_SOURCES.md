# OpenTalk Technical Brief Source Ledger

**Prepared:** 13 October 2026  
**Repository state:** version 0.2.0 at commit `6a7f09a` (`updated installer`)  
**Purpose:** Trace the major technical and feature claims in `docs/technical-brief/TECHNICAL_BRIEF.md` and `docs/technical-brief/OpenTalk_Technical_Brief.pdf` to repository evidence and current official documentation.

## Evidence policy

- **Implemented** means the current source contains the behavior and deterministic automated checks cover its critical pure or mocked paths.
- **Packaged** means the repository's recorded packaging verification found the expected files and hashes in the current 0.2.0 installer artifact.
- **Measured** is limited to the stated fixture, build, machine, and measurement boundary; it is not a general performance guarantee.
- **Unverified** means the behavior still requires attended Windows hardware, account, installation, or cross-application evidence.
- Commit history is used to explain feature evolution, not to substitute for current-source verification.

## Requirements and design baseline

| Claim group | Primary evidence | Notes |
|---|---|---|
| Active scope and acceptance | `REQUIREMENTS.md`, especially WA01–WA09 and the W10–W31 follow-up requirements | WA01–WA06 define the working-preview core; later requirements add meetings, Assistant, hub/history, overview, tasks, styles, themes, packaging, and keyboard hardening. |
| Current component and trust boundaries | `ARCHITECTURE.md` | Main process is authoritative; renderer/preload/native/network/storage boundaries are explicit. |
| Current execution and release state | `TASKS.md`, W01–W32; `SCRATCHPAD.md`, current handoff and W10–W32 entries | Records exact commands, test counts, installer evidence, failures, and remaining attended checks. |
| User-facing behavior | `README.md` | Cross-checked against source; the brief does not rely on README alone. |

## Architecture and lifecycle claims

| ID | Claim | Source evidence |
|---|---|---|
| A01 | React renderer, narrow preload bridge, authoritative Electron main, Rust helper, and persistent C++ worker | `apps/desktop/renderer/src/main.tsx`; `apps/desktop/preload/index.ts`; `apps/desktop/main/index.ts`; `native/helper/src/main.rs`; `native/worker/main.cpp`; `ARCHITECTURE.md` component model |
| A02 | Renderer isolation, sender/origin validation, blocked navigation/windows/permissions | `apps/desktop/main/index.ts` window/web-contents policy and IPC registration; `apps/desktop/preload/index.ts`; `apps/desktop/renderer/index.html` CSP |
| A03 | Versioned main/helper JSON and private helper/worker OTW2 binary protocol | `apps/desktop/main/native.ts`; `packages/core/src/contracts.ts`; `native/helper/src/main.rs`; `native/helper/src/speech.rs`; `native/worker/main.cpp`; `ARCHITECTURE.md` protocols |
| A04 | Unique session IDs, explicit lifecycle, ordered events, stale-event rejection, cancellation barrier, one insertion budget | `packages/core/src/session.ts`, `SessionCoordinator`; `tests/session.test.ts`; `tests/live-session.test.ts`; `REQUIREMENTS.md` WA01/WA05 |
| A05 | Release-time speculative cleanup, exact-final reuse, two-request budget | `packages/core/src/session.ts`, speculative cleanup and cleanup-budget paths; W14 records in `REQUIREMENTS.md`, `TASKS.md`, and `SCRATCHPAD.md` |
| A06 | Successful SSE terminal event and non-empty output required; incomplete/failed/tool-bearing output rejected | `packages/core/src/cleanup.ts`, response streaming/parser validation; cleanup tests; WA02 |

## Feature claims

| ID | Feature area | Source evidence |
|---|---|---|
| F01 | Hold-to-talk dictation, configurable shortcut, local preview, cleanup, guarded insertion | `apps/desktop/main/hotkeys.ts`; `packages/core/src/session.ts`; `native/helper/src/hotkeys.rs`; `apps/desktop/main/index.ts`; renderer recording-layer components; WA01–WA06 |
| F02 | Moonshine default; Whisper base/small selectable; verified model installation | `packages/core/src/moonshine-model.ts`; `packages/core/src/models.ts`; `native/worker/moonshine.hpp`; `native/worker/main.cpp`; `tools/build-native.ps1`; W08/W12 |
| F03 | Default, Minimal, Casual, Professional, Extensive styles | settings schemas in `packages/core/src/contracts.ts` and persistence in `packages/core/src/storage.ts`; cleanup-instruction construction in `packages/core/src/cleanup.ts`; Styles UI in `apps/desktop/renderer/src/main.tsx`; W21 |
| F04 | Default/Expressive language, Default/Vibrant/Gradient themes, reduced motion | recording-layer state/components/styles under `apps/desktop/renderer/src`; settings schema; W22–W24/W31 |
| F05 | Command Mode text-only constraints and non-persistent layer toggle | `packages/core/src/session.ts`; cleanup/generation instruction construction; recording-layer UI; W25/W26 |
| F06 | Exact local `Start Meeting` command with no cleanup/history/insertion | `packages/core/src/commands.ts`; command handling in `packages/core/src/session.ts`; command tests; W19 |
| F07 | Meeting mic + selected playback loopback, bounded mixer, pause/resume, previews | `packages/core/src/meetings.ts`; `native/helper/src/audio.rs`; helper meeting control in `native/helper/src/main.rs`; meeting IPC/UI in desktop main/renderer; W15/W18 |
| F08 | Meeting raw transcript durability, title/short/long/minutes summaries, search/delete/detail/export | `EncryptedMeetingStore` in `packages/core/src/storage.ts`; `packages/core/src/meetings.ts`; meeting render/export paths in `apps/desktop/main/index.ts` and renderer; W15/W16 |
| F09 | Up to 1,000 audio bookmarks and transcript navigation | meeting session coordinator and bookmark validation in `packages/core/src/meetings.ts`; meeting UI; W18 |
| F10 | Selected-text Assistant, passive exact UIA selection, review, Replace/Add, direct native paste when verified, fallback copy | `packages/core/src/assistant.ts`; selection/focus adapter paths in `apps/desktop/main/native.ts`; `native/helper/src/target.rs`; `native/helper/src/main.rs`; Assistant UI; W17/W29/W31 |
| F11 | Main-process 60-second copy recovery, no renderer return and no insertion retry | `apps/desktop/main/index.ts`; recovery state in `packages/core/src/session.ts`; preload bridge and tests; W13 |
| F12 | Protected dictation history and limits; search/paging/copy/delete/duration; no Paste | `packages/core/src/storage.ts`; history IPC and renderer views; WA07/W20 |
| F13 | Protected meeting store and limits | meeting storage module and tests; meeting IPC; W15 |
| F14 | Overview counts, recent entries, longest dictation, bounded AI recap, usage link | overview selectors/request builders in core and desktop main/renderer; W20 |
| F15 | Weekly Tasks extraction, top three, source navigation, in-memory digest cache, no task database | `packages/core/src/tasks.ts` and tests; `apps/desktop/main/index.ts`; Overview/Tasks UI paths; W27/W28 |
| F16 | Dictionary, devices, models, shortcuts, login launch, layer visibility, Test Mic, enable/disable | `packages/core/src/contracts.ts`; `packages/core/src/storage.ts`; device/model/account coordinators; Settings/Dictionary UI in renderer; WA01/WA03/WA06 |
| F17 | Multi-account browser OAuth, account selection/reconnect/disconnect, discovery, usage link, cleanup test | `packages/core/src/oauth.ts`; `packages/core/src/accounts.ts`; auth/model IPC in `apps/desktop/main/index.ts`; settings UI; WA02/W09 |
| F18 | Single instance, tray/hub/layers, non-activating/topmost windows, three-second hint, mutual exclusion | `apps/desktop/main/index.ts`; window controllers; renderer entry points/styles; W07/W17/W31 |
| F19 | Per-user NSIS installer, Start menu, no elevation/desktop shortcut, external mutable data | `tools/package.mjs`; `package.json`; package/installer scripts; W30/W32 records |

## Audio, insertion, storage, and privacy claims

| ID | Claim | Source evidence |
|---|---|---|
| S01 | Mic-only normal capture; selected render endpoint only during Meeting | `native/helper/src/audio.rs`; helper command routing; WA01/W15 privacy requirements |
| S02 | Mono conversion, stateful resampling to 16 kHz i16, 20 ms meeting mix, saturation and silence substitution | `native/helper/src/audio.rs` and native audio tests |
| S03 | Bounded audio channel/frame/source buffers; memory-to-spool transition; disk and file limits | `native/helper/src/audio.rs`; `apps/desktop/main/native.ts`; native limits in `packages/core/src/contracts.ts`; WA03 |
| S04 | Target identity, focus/selection generations, secure/password/elevation/terminal guards | `native/helper/src/target.rs`; target schemas in `packages/core/src/contracts.ts`; adapter validation in `apps/desktop/main/native.ts`; WA04/W17/W29 |
| S05 | Single insertion consumer, physical-key preflight, four-event `Ctrl+V`, no retry | `native/helper/src/main.rs`; `native/helper/src/hotkeys.rs`; native tests; W29 |
| S06 | Clipboard snapshot caps, ownership-aware restore, excluded bitmap formats, configurable restore delay | native clipboard/insertion code and tests; WA04 |
| S07 | Atomic settings; DPAPI-protected accounts/history/meetings; bounded records/bytes | `packages/core/src/contracts.ts`; `packages/core/src/storage.ts`; `packages/core/src/accounts.ts`; desktop main protected-storage adapter |
| S08 | Feature-specific bounded cloud payloads | request builders/tests for cleanup, meeting summary, Overview recap, Weekly Tasks, and Assistant; privacy requirements in WA02/W17/W20/W27 |
| S09 | Tokens remain in main; native processes get no tokens; app-local trusted process spawning | `apps/desktop/main/index.ts`; `apps/desktop/main/native.ts`; `packages/core/src/accounts.ts`; WA02/WA03 |
| S10 | Model origin/redirect/size/hash verification and atomic installation | `packages/core/src/models.ts`; `packages/core/src/moonshine-model.ts`; `tests/models.test.ts`; WA03/W12 |
| S11 | Package privacy audit and exact artifact checks | `tools/package-privacy.mjs`; `tools/package.mjs`; package scripts in `package.json`; W30/W32 scratchpad evidence |

## Performance and test evidence

| Evidence | Repository record | Interpretation used in brief |
|---|---|---|
| 243 offline tests plus strict type-check, lint, and production builds | Current `SCRATCHPAD.md` handoff for W32; `package.json` check script | Current offline verification count, not live/native acceptance |
| 30 native tests passed; 2 attended tests ignored | W29 scratchpad/task record | Native deterministic coverage; real application checks still required |
| Whisper 20-run median/p95 844/878 ms; prior 895/1,127 ms | W10 scratchpad performance entry | Reduced variation; no claimed throughput improvement |
| Synthetic 194–198 wpm recognition 1.314–2.281 s | W11 scratchpad evaluation entry | One-second full-path objective not met |
| Moonshine public sample 664 ms stop-to-final; cold/reuse preparation 761/5 ms | W12 scratchpad acceptance entry | One scoped sample, not a percentile guarantee |
| Whisper worker approximately 255.7 MiB physical and 751.5 MiB private commit | W10 scratchpad resource entry | Excludes Electron and does not establish a full resource envelope |
| Installer 310,007,826 bytes; SHA-256 `020edf970608ac19af5a4b16cf55af225d9b00a56ecba2501be45401cbacfbba` | Current W32 handoff | Artifact identity only; installer launch remains unverified |

## Git evolution

| Evolution stage | Representative commits | What changed |
|---|---|---|
| Foundational vertical slice | `a560be4`, `f4af3ef` | Repository baseline and first end-to-end local dictation architecture |
| Persistent layer and desktop experience | `bc6a4cf`, `67fb923` | Always-available overlay/hub behavior and user-facing lifecycle refinement |
| Meetings | `c0c4bcb`, `7413e8a`, `c90a74b`, `ceed637`, `bd4ab03`, `52ce392`, `7c20813` | Meeting capture, shortcut correction, Markdown minutes, playback loopback, bookmarks, detail UI, and AI summaries |
| Assistant | `430a6eb`, `dd33e7a`, `e1b76c1`, `2d4d303` | Selection bubble, Notepad/native edit support, and motion/interaction refinement |
| Overview and summaries | `8b80d99`, `a4cfded` | Dashboard metrics, recent records, and bounded topic-summary refinement |
| Styles, themes, and Command Mode | `25a7d35`, `eb94d0f`, `b8db7af`, `d3db1d2`, `baa6f8f`, `a164289` | Cleanup styles, color systems, Gradient theme, constrained generation mode, and mode labeling |
| Weekly Tasks | `dfd05e5`, `54ff889`, `f132454` | Task extraction, dedicated UI, source navigation, and overview integration |
| Keyboard and layer hardening | `46b40b9`, `09e555e`, `0c5f3b3` | Passive selection/shortcut fixes, early packaging, and overlay visibility corrections |
| Current installer | `6a7f09a` | Versioned 0.2.0 installer and current packaged artifact |

## Official external references checked

The following primary documentation was checked on 13 October 2026 because these interfaces and security recommendations can change:

- [OpenAI Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/sign-in): loopback redirect, PKCE, state, nonce, and scope guidance.
- [OpenAI models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference): Responses request shape, streaming, `store: false`, and terminal-event handling.
- [OpenAI profiles and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions): account registrations, serialized refresh, rotating refresh tokens, and revocation behavior.
- [OpenAI GPT-5.6 Luna model documentation](https://developers.openai.com/api/docs/models/gpt-5.6-luna): model capabilities and supported reasoning effort.
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security): context isolation, sandboxing, CSP, navigation, permission, and IPC guidance.
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage): OS-backed encryption behavior and Windows DPAPI limitations.
- [Microsoft SendInput](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput): serialization, keyboard-state interaction, and UIPI limitation.
- [Microsoft LowLevelKeyboardProc](https://learn.microsoft.com/windows/win32/winmsg/lowlevelkeyboardproc): callback timing and dedicated-thread guidance.

## Known gaps and non-claims

- The installer is unsigned and has not been launched in the current evidence cycle for clean-install, upgrade, uninstall, or installed-runtime acceptance.
- Live ChatGPT subscription flows, plan accounting, remote revocation, and model responses are not covered by the unattended offline suite.
- Real microphone and playback hardware, device removal, Teams/Zoom/browser playback, and complete Meeting end-to-end behavior remain attended checks.
- Assistant and dictation insertion are not certified across a broad application matrix. Notepad is the strongest recorded application-specific evidence; protected, elevated, terminal, changed-focus, and changed-selection cases are expected to abort.
- No current WER benchmark, complete stop-to-formatted-field percentile set, full-process resource envelope, long refresh-endurance run, crash stress suite, accessibility certification, or Windows-version compatibility matrix exists.
- The brief does not claim speaker diarization, speaker labeling, cloud transcription fallback, agentic tools, browser automation, command execution, application-content harvesting, automatic form submission, secure deletion, zero provider retention, production readiness, or broad distribution readiness.
