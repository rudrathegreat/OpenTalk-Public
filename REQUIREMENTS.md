# Working-preview requirements

## Authorized OpenTalk follow-up - 4 October 2026

The OpenTalk product increment supersedes the earlier product name and history-off default for new builds:

- The product and runtime identity are **OpenTalk**, using fresh OpenTalk package, protocol, executable and application-data identities. Earlier Personal Dictation data remains untouched and is not migrated.
- The desktop hub uses locally bundled Manrope and a dark reference-inspired shell. Its in-app destinations include Overview, Tasks, Dictation, Dictionary, Styles, Meetings, Commands and Settings: Tasks surfaces weekly self-assigned actions, Dictionary owns preferred vocabulary, Styles owns cleanup, software-experience and recording-layer colour preferences, Commands documents the fixed local voice-action catalog, and Settings owns account, microphone, model, hotkey and application controls. Usage retains its external ChatGPT usage action.
- Each validated cleaned result from a successful or safely blocked terminal session is saved once in DPAPI-backed local history. Raw audio/transcription, silence, cancellations and failures are never history entries.
- History provides local-time day/time display, complete message text, bounded case-insensitive search, clipboard Copy and confirmed per-item deletion. There is no history Paste action or bulk delete.

The project subsequently added the supplied square logo to the Windows shell and a local x64 installer with an OpenTalk Start-menu shortcut. This does not expand the working-preview completion label into a signed or distribution-ready release.

The shareable installer must contain no developer or user personal state. The packaging path must exclude account credentials/labels, encrypted history, settings, browser/cache/session state, build-user paths and other personal identifiers, and must fail closed if those artifacts enter the payload. Reinstalling on the same Windows account may reuse the external `%APPDATA%\OpenTalk` profile; that local profile must not be deleted or mistaken for installer content.
- History is limited to 5,000 entries or 50 MiB and atomically removes the oldest items at the cap. Protection/history failure is visible but does not prevent otherwise safe dictation.

This document defines the only acceptance gate currently in force: get one real, short dictation through the existing Windows application. The broader release specification was retired from the active milestone on 2 October 2026 because it was preventing a usable vertical slice from being demonstrated.

The current milestone is a **developer-run working preview**, not an installer, a general release, or a claim that dictation works everywhere. [TASKS.md](TASKS.md) is the matching execution queue. [ARCHITECTURE.md](ARCHITECTURE.md) retains the intended long-term design, and [SCRATCHPAD.md](SCRATCHPAD.md) retains historical evidence and risks.

## Working-preview outcome

**Authorized performance follow-up - 5 October 2026:** preserve speech/cleanup quality while reducing short-dictation startup and processing latency. Prepare the verified selected model before dictation activation without ambient capture; reuse it until disable/quit. Collect opt-in local stage durations without sensitive content, overlap token preparation with local recognition, finish cleanup at validated terminal completion, and persist history independently of completion feedback. Report measured first-use/warmed performance; full live speed claims require attended account/target evidence. Existing WA02-WA06 safety gates remain in force.

**Authorized CPU-only live follow-up - 5 October 2026 (W11):** keep recognition exclusively on CPU and preserve the selected speech model, context and quality settings. Prioritize dictations under 30 seconds at approximately 200 wpm, targeting final formatted text within one second of release without promising that threshold from inspection. Decode bounded in-memory previews during explicit recording with adaptive scheduling and give end-of-stream-covered final recognition priority. The request budget permits one speculative text-only cleanup request during recording and at most one final request; an early response may be reused only after identical final input and successful terminal completion are verified. Canceling does not retract draft text already sent to the provider. No early insertion, cloud audio, document harvesting, GPU dependencies or raw-text formatting fallback is authorized. Retain low cleanup reasoning until attended account-route and semantic checks establish that none preserves quality. Track paste dispatch separately from clipboard restoration, and report latency misses rather than weakening acceptance.

**Authorized Moonshine follow-up - 6 October 2026 (W12):** add English Moonshine Small Streaming as a CPU-only model and make it default on fresh install and one-time v1/v2 upgrade. Retain Whisper Base/Small choices/weights and other preferences/protected state. Pin and verify official runtime/model assets; bundle default weights with the local preview installer. Existing explicit-capture, bounded-buffer, cancellation, EOS, text-only completed cleanup, formatting and guarded-insertion gates remain in force. Cleanup model/reasoning is unchanged. Separate synthetic recognition measurements from attended full release-to-formatted-field latency; do not claim Wispr Flow parity.

**Authorized no-reasoning follow-up - 6 October 2026 (W13):** use `reasoning: { effort: "none" }` when supported, superseding W11's requirement to retain low reasoning until attended validation. Keep the existing account-discovered GPT-5.6 Luna model, text-only route, formatting/correction instructions, CPU speech models, request budget and completion/insertion guards. Show None in Settings and rebuild the local preview installer. Verify the request shape and failure behavior offline; live account-route acceptance, formatting fidelity and actual speed improvement remain unverified until attended testing. Do not silently fall back to another model, effort, raw transcript or paid route.

**Authorized post-dictation latency follow-up - 6 October 2026 (W14):** replace the in-recording pause/stability cleanup trigger with one release-triggered speculative request using the newest valid nonempty preview. Launch it before capture drain/final recognition completes, and reuse it only when its trimmed input exactly matches the fully drained final transcript and its response has a valid `response.completed`; any difference, including punctuation, permits at most one final request. Recordings without a preview use only the final request. Keep cancellation, silence, correction, stale-session and insertion protections. After the one guarded `SendInput`, acknowledge insertion without waiting for the retained 350-ms clipboard-restoration interval; serialize clipboard transactions, restore only while the sequence is still owned, allow the next capture after native session discard, and drain restoration on orderly Quit. This changes completion latency, not proof of target text appearance or broad clipboard compatibility.

**Authorized default-microphone follow-up - 6 October 2026 (W15):** when a fresh or unavailable saved microphone is reconciled, select and atomically save the normal Windows default capture endpoint. Identify the default by WASAPI endpoint identity for the `eConsole` role, not by display name. Preserve every available saved manual selection, including a nondefault device; do not follow later Windows-default changes while that selection remains available. If Windows reports no default, retain the unresolved setting and keep dictation unavailable. Corrupt-settings recovery still requires explicit review. Enumeration and selection never open the microphone; capture remains explicit.

**Authorized blocked-insertion recovery follow-up - 6 October 2026 (W16):** when a validated cleaned result cannot be inserted or the insertion outcome is uncertain, show a Copy button in the nonactivating recording overlay. Copy only that cleaned terminal result through a narrow main-process clipboard action; never expose it to renderer state, retry insertion, or copy raw/partial transcription. The overlay accepts pointer input only for that recovery action and remains nonfocusable so the original application retains keyboard focus. Successful copy consumes and dismisses the result; clipboard failure keeps it available until the existing 60-second expiry, new recording, disable/disconnect, or quit.

**Authorized overlay-visibility follow-up - 6 October 2026 (W17):** provide a persisted user setting that either keeps the nonactivating recording overlay visible at all times or returns it to the existing behavior of hiding after terminal feedback. Existing profiles and fresh installs default to hiding it. The always-visible choice shows an accurate Disabled state when dictation is disabled, remains click-through except for an available blocked-result Copy action, and does not start capture or broaden renderer privileges.

**Authorized overlay-visibility repair - 10 October 2026 (W17/W20/W23):** later meeting work must not override the saved visibility choice. When `Keep recording overlay visible` is off, the ordinary layer hides while idle or disabled after the existing bounded launch hint and appears for an active dictation lifecycle or meeting lifecycle. Explicitly saving the off choice dismisses the launch hint immediately. The selected-text assistant remains independently visible in its dedicated bubble/window and does not require the ordinary layer to stay mounted. When the choice is on, the compact idle layer retains `Start meeting`.

**Authorized software-experience follow-up - 6 October 2026 (W18):** add a persisted Styles choice between Default and Expressive recording-overlay language. Default retains the consistent `Recording`, `Processing` and `Done` labels. Expressive selects one playful message when entering each of those presentations and keeps it stable for that presentation; transcription, cleanup and insertion still share one processing presentation. Idle, disabled, blocked, busy and unavailable messages remain unchanged. Existing profiles and fresh installs default to Default.

**Authorized meetings and lectures follow-up - 7 October 2026 (W20):** when the saved overlay choice is on, keep a compact nonactivating recording layer visible with a `Start meeting` action whenever push-to-talk dictation is not active. Regardless of that choice, starting a meeting makes the layer visible, contracts its compact state when present, moves it to the top center, expands it into a rounded recorder, and shows local live transcript previews with Recording, waveform, Pause/Resume and Stop controls. Returning to normal mode likewise keeps the meeting recorder mounted for a damped contract and fade before restoring or hiding the compact layer according to the saved choice. Pause closes and finalizes the current local transcription segment; Resume starts a new segment without sending audio to the provider. Stop must save the validated raw transcript to a separate DPAPI-backed meeting store before requesting a title, short list summary, long detail summary and Markdown meeting minutes through the selected account's existing text-only Responses route. An AI failure preserves the raw transcript and reports the summary as unavailable. The hub adds Meetings list/detail views following the supplied designs, bounded search, per-record deletion and explicit Markdown export through a native save dialog. Generated Markdown is parsed into inert React elements; raw HTML, remote images, navigation and executable content remain disabled. No diarization is claimed and the raw transcript does not display a synthetic speaker label. Live microphone, account-route and long-duration acceptance remain required before calling the feature end-to-end verified.

**Authorized audio-bookmarks follow-up - 10 October 2026 (W20):** while Meeting capture is actively recording, place one icon-only bookmark action next to Pause. Each activation creates one bounded bookmark at the elapsed recorded-audio time; paused time is excluded. Stop stores the ordered bookmark timestamps and reconciled raw-transcript positions in the same encrypted meeting record before summary generation, so provider failure cannot remove them. The Raw Transcript detail view lists bookmark timestamps and lets the user jump to and visibly identify each corresponding transcript position. This stores navigation metadata only and does not authorize retaining raw audio after transcription.

**Authorized audio-bookmark presentation refinement - 10 October 2026 (W20):** place each bookmark marker on its own raw-transcript line. The navigation area contains only borderless bookmark buttons, with no `Bookmarks` heading or empty-state label. Raw transcript cards have no border or synthetic speaker label. The selected Raw Transcript underline must share the same baseline as the grey content separator.

**Authorized meeting playback-capture follow-up - 10 October 2026 (W20):** an explicitly started Meeting session captures both the selected microphone and the selected Windows playback endpoint so local speech and remote speech rendered by provider-independent desktop/browser meeting applications reach the same local transcription pipeline. Playback capture uses shared-mode WASAPI loopback only while the Meeting lifecycle owns capture; ordinary dictation and Assistant sessions remain microphone-only. Settings persist a playback endpoint separately from the microphone, reconcile a missing choice to the normal Windows default render endpoint, and block Meeting startup when that endpoint is unavailable without disabling ordinary dictation. The native helper resamples each source independently, combines them into one bounded real-time mono stream without concatenating their timelines, and closes both streams on Pause, Stop, cancellation, disable, device failure and Quit. No application-specific meeting integration, per-process audio-session enumeration, cloud audio upload, background playback monitoring, speaker attribution or diarization is authorized.

**Authorized overview follow-up - 7 October 2026 (W21):** make Overview the hub's default destination and closely follow the supplied dark dashboard reference using the repository background image. Show the two newest encrypted dictation entries with local times and confirmed per-item deletion, plus Monday-local weekly totals for dictated words, completed meeting/lecture records and the longest recorded dictation capture. Statistics must be computed from local protected stores rather than hardcoded reference values. Record bounded capture duration with new successful/blocked dictation history entries; existing entries without duration remain valid and the UI shows an unavailable value rather than estimating one. `See dictations` opens Dictation and `See usage` retains the external ChatGPT usage action.

**Authorized overview-summary follow-up - 11 October 2026 (W21):** replace the static paragraph beneath the Overview title with a short AI-generated account-route summary of the current Monday-local week's usage. Send only the weekly start and the three existing aggregate values; never send dictation text, meeting transcripts, titles or generated meeting content for this summary. Use the existing selected-account model, stateless streamed request and completion-only validation. Coalesce matching requests and retain the successful result in memory for the exact week and totals. Account/provider failure must leave the Overview usable with a truthful local aggregate summary rather than hiding recent items or statistics.

**Authorized topic-led overview-summary refinement - 11 October 2026 (W21):** supersede the aggregate-only request boundary for this feature so the weekly recap can mention one or two concrete topics and use a warmer, lightly playful voice instead of reading like a statistics report. Along with the existing aggregates, the request may include a bounded newest-first sample of complete cleaned dictations from the current week and titles plus short summaries from ready current-week meetings. Send at most ten complete items, no item over 2 KiB and no more than 12 KiB of topic text in total; skip an item whole rather than slicing its meaning. Do not send raw meeting transcripts, minutes, bookmarks, identifiers or items from before the local-week boundary. Treat sampled content as untrusted, do not follow embedded instructions, and do not claim the sample is comprehensive or identify dominant/recurring themes. The output remains inert text, completion-only, stateless and subject to the existing local fallback.

**Authorized deterministic commands follow-up - 8 October 2026 (W22):** add Commands to the hub and introduce the first fixed voice command, `Start Meeting`. After final local transcription, an exact normalized `start meeting` utterance is consumed locally, fully releases the dictation capture, and starts the existing meeting lifecycle. It never becomes cleaned text, history or an insertion. Case, whitespace and terminal punctuation may be normalized; added words do not match. This narrowly supersedes the earlier blanket prohibition on command execution only for reviewed in-product actions in the compiled catalog. It does not authorize shell commands, arbitrary tools, generated action names, surrounding-content access or an always-listening mode.

**Authorized selected-text assistant follow-up - 9 October 2026 (W23):** when the user explicitly highlights text in a verifiable ordinary-privilege edit/document control, show a separate transparent assistant bubble next to that selection. Clicking it starts the configured microphone only for the assistant command; Stop ends capture, local transcription supplies the command, and the existing selected-account Responses route returns a plain-text transformation for review. This narrowly supersedes the selected-text prohibition only for the exact user-highlighted range captured for this explicit action; surrounding content, screenshots, window titles and unselected text remain prohibited. UI Automation is the primary capture path; when the focused edit/document provider cannot expose its selected range, one bounded Ctrl+C capture may be used and the previous clipboard restored. The captured copy remains authoritative during transcription/generation. At accept, restore and revalidate the original ordinary-privilege window/control plus the exact selected text through the capture method, then make one paste attempt. Only verified native Edit/RichEdit controls may receive synchronous `WM_PASTE`; custom editors use one guarded Ctrl+V. No Delete/Backspace or insertion retry is allowed, and a failed validation leaves an explicit Copy fallback. The assistant must not change the default recording layer or microphone picker, and assistant-window registration/failure must not block microphone enumeration or ordinary dictation.

**Authorized dictation-style follow-up - 11 October 2026 (W24):** Styles offers five dictation preferences using label-only options: Default, Minimal, Casual, Professional and Extensive. Default replaces the former Adaptive name while retaining its cleanup behavior, and existing Adaptive settings migrate to Default. Casual rewrites as relaxed everyday messaging; Professional rewrites in polished, diplomatic corporate language; Extensive produces comprehensive, explicit task instructions suitable for an agent. Every style still applies corrections, preserves substantive facts and constraints, treats transcript/vocabulary as untrusted text, invents no unsupported details and never executes or answers the dictated content. Extensive may add plain-text headings and lists for clarity but must leave missing requirements unspecified rather than infer them.

**Authorized recording-layer colour-theme recovery - 11 October 2026 (W25):** restore the independent persisted Styles choice between Default and Vibrant without reverting any W20-W24 behavior. Default preserves the neutral compact layer. Vibrant renders Recording and blocked insertion in bright red, Processing in white and successful Done in green, with the previously approved subtle contract/expand transition. Idle, disabled, unavailable, Assistant and the expanded Meeting recorder remain unchanged. Reduced-motion preferences remove the added motion without removing state colours. Settings v8 must migrate current v7 profiles to Default, preserve all newer dictation/playback/account choices, and also recognize the earlier strict v6 colour-theme shape so a saved Vibrant choice is not discarded.

**Authorized subtle-gradient colour-theme follow-up - 11 October 2026 (W26):** add Gradient as a third Styles colour-theme choice without changing Default or Vibrant. It retains the same red Recording/blocked, white Processing and green Done state identity as Vibrant, but presents those colours as low-opacity diffuse blobs over the neutral compact layer. Multiple clipped blobs move continuously on slow, non-distracting cycles behind legible status content. Idle, disabled, unavailable, Assistant and the expanded Meeting recorder remain unchanged. Reduced-motion preferences preserve the static diffuse gradients while stopping blob and state-transition motion. Gradient persists within the existing strict settings v8 shape.

**Authorized Command Mode follow-up - 11 October 2026 (W27):** replace the compact recording layer's `Start meeting` action with a `Command mode` toggle. While active, the compact layer has a pure-white border and the next push-to-talk sessions retain the ordinary dictation capture, transcription, status, cancellation, guarded one-attempt insertion, recovery and protected-history lifecycle, but the selected account model follows the transcript as a text-generation request instead of cleaning it. Command Mode may return only inert text artifacts such as prose, code, LaTeX, Markdown or structured text. It receives no tools and must not browse, access files, run code, operate software, send messages, claim an external action completed or dispatch the compiled local `Start Meeting` voice action. The mode is snapshotted at session start and is not a persisted setting. Existing meeting entry through the Commands hub and meeting shortcut remains available.

**Authorized Command Mode interaction refinement - 11 October 2026 (W27):** when Command Mode is active, the inner Command mode control has no visible border; the pure-white border belongs only to the outer recording layer. Give the control a forgiving click target without enlarging its visible treatment. Preserve an authorized hovered compact action across the resulting status publication so activation and deactivation do not require moving the pointer away and back, while resetting pointer capture whenever the compact state no longer permits an action.

**Authorized weekly tasks follow-up - 11 October 2026 (W28):** add Key tasks immediately below the Overview hero and show the three highest-ranked current-week tasks the user explicitly assigned to themselves in protected dictations or meetings. Add a Tasks hub destination that shows the complete validated weekly result, bounded to 50 tasks. Task extraction uses the existing selected-account stateless streamed Responses route and the current Monday-local week. Send at most 50 newest complete source items, capped at 16 KiB each and 96 KiB total; omit an over-limit item whole, never silently slice it. Ready meetings contribute their title and long summary, while a non-ready meeting may contribute its raw transcript only within those same bounds. Do not send record identifiers, bookmarks, minutes, raw audio or pre-week content. Treat every source as untrusted, accept only a terminal completed strict JSON object, bind displayed source type/time from local metadata, and do not infer suggestions, completed work or tasks assigned only to others. Cache only the exact successful result in memory under a content digest; do not create a task database. Missing account/provider access or unavailable protected sources must leave the rest of Overview and the Tasks tab usable with a truthful unavailable/limited state.

**Authorized weekly tasks presentation refinement - 11 October 2026 (W28):** remove the Help sidebar label and the decorative marker beside each task. Remove the explanatory sentence below the Tasks heading and the bounded-source sentence below Overview Key tasks. On the full Tasks destination, place a borderless source action to the right of every task. A dictation-sourced task uses `See Dictation`, opens Dictation, scrolls to and identifies the exact protected history entry; a meeting-sourced task uses `See Meeting` and opens the exact Meeting detail rather than misrepresenting it as a dictation. Bind the protected local source-record identifier only after source selection and exclude it from the provider request.

**Authorized critical keyboard-interference repair - 12 October 2026 (W29):** passive selected-text observation is UI Automation-only and must not synthesize Ctrl+C, send WM_COPY or modify the clipboard while OpenTalk is idle. This supersedes W23's passive clipboard-copy fallback; controls that cannot expose a nonempty exact selection through UI Automation do not receive an automatic Assistant offer. Remaining explicit-session Ctrl+C/Ctrl+V shortcuts use one ordered SendInput batch, are serialized with insertion, fail closed while physical modifiers are held and clean up only synthetic key-down events owned by a partial batch without releasing a physically held key. The Ctrl+Shift hold shortcut observes but does not suppress its modifiers, and a third application-shortcut key cancels a pending hold while passing the complete shortcut through. Meeting Space and active-session Esc remain the only configured keystrokes consumed with their matching releases. No global keyboard reset, Delete, Backspace, Enter or insertion retry is authorized.

**Authorized Assistant-layer motion refinement - 13 October 2026 (W31):** make the dedicated Assistant and ordinary recording layers mutually exclusive. A selected-text Assistant offer contracts the currently visible ordinary layer before showing its bubble; clearing the selection contracts the Assistant before restoring the ordinary layer according to the saved visibility choice. This supersedes W23 only where it said the Assistant must not change the default recording layer: capture, microphone selection and ordinary dictation behavior remain unchanged. The Assistant's compact states size to their content with the same smooth, subtly elastic motion language as recording and Meeting, use a materially narrower recording state, and center Processing. The review action `Replace selected text` uses a white background with `#111` text. Reduced-motion preferences remove the added motion without changing state or visibility.

On a supported Windows development machine, the application must:

1. start from the documented development command and reach a usable ready state;
2. connect one deliberately selected ChatGPT account through the production GUI;
3. capture a short English utterance from a selected real microphone;
4. transcribe the audio locally with the existing `whisper.cpp` worker;
5. obtain validated cleaned text through the account-authorized route (the W11 follow-up permits one speculative and one final request); and
6. insert the completed result exactly once into an unchanged disposable test input.

The milestone passes when three consecutive short dictations complete that path, plus one cancellation and one focus-change test both produce zero insertion. Record the commands, environment, chosen model, and sanitized result. Do not record tokens, private audio, account identifiers, or full private transcripts.

## Active requirements

### WA01 - Runnable local desktop

- The existing Electron application launches on the supported Windows development machine without administrator elevation.
- The UI makes account, microphone, local model, enabled/disabled, recording, processing, unavailable, and ready states understandable enough to run the preview.
- Settings offers a persisted choice between an always-visible recording overlay and the default behavior that hides it after recording/terminal feedback.
- Styles offers a persisted Default/Expressive software-experience choice that changes only Recording, Processing and Done overlay language.
- Styles offers independent Default, Vibrant and Gradient compact-layer colour choices. Vibrant uses solid red Recording/blocked, white Processing and green Done states; Gradient uses the same palette as slow diffuse blobs, and both respect reduced motion.
- Quit releases microphone capture, keyboard hooks, helper, and worker processes.
- Manual developer setup and an existing verified local model are acceptable for this milestone.

**Pass:** launch, reach the settings UI, close/reopen if needed for the test, and quit without a surviving app-owned capture or worker process.

### WA02 - One production account connection and completed cleanup

- Use the production GUI's Continue with ChatGPT flow with one deliberately selected account.
- Keep tokens in the protected main-process store; never expose them to the renderer, native helper, logs, or documentation.
- Discover an available model and accept cleanup text only after a successful completed terminal response with nonempty output.
- Authentication, HTTP, interrupted-stream, incomplete-output, or empty-output failure inserts nothing.

**Pass:** the production application signs in and completes one short cleanup request. Existing deterministic tests for completed and failed streams remain green.

### WA03 - Short real-microphone capture and local transcription

- Use the selected microphone only after an explicit start.
- The existing default hold shortcut or an existing explicit UI control may start the preview; shortcut configurability and hands-free mode are not required.
- Releasing/stopping ends capture. Cancel, Disable, or Quit prevents the session from producing an insertion.
- Audio remains local and is transcribed by the existing worker. This milestone targets short utterances of up to five minutes; longer recordings may fail visibly.

**Pass:** three short real-microphone captures produce nonempty, intelligible local transcripts, silence does not produce an insertion, and capture stops on release/cancel.

### WA04 - Basic cleanup outside the fixed command catalog

- Remove obvious fillers and apply an explicit self-correction without dropping the main request.
- Preserve important names, dates, amounts, negations, and uncertainty in the tested utterance.
- Persist and apply the selected Default, Minimal, Casual, Professional or Extensive dictation style. Default retains the former Adaptive behavior; style changes may rewrite tone or structure but must preserve substantive meaning and supported constraints.
- Except for an exact match in the reviewed deterministic command catalog, treat dictated instructions as text. Never invoke shell commands, arbitrary tools, generated action names, synthesize Enter, or answer dictated content.

**Pass:** the end-to-end samples preserve their stated meaning, including at least one correction or constraint. A formal multi-run semantic benchmark is not part of this milestone.

### WA05 - Guarded, at-most-once insertion

- Capture the intended input at recording start and recheck it immediately before insertion.
- Insert only into a disposable ordinary-privilege test target controlled for this test.
- A changed or unverifiable target, cancellation, stale completion, secure/password target, or failed cleanup causes zero insertion.
- Each session has an insertion-attempt budget of one. An uncertain outcome is never retried automatically.
- A blocked or uncertain terminal result offers one explicit overlay Copy action without focusing the overlay or exposing result text to the renderer. Clipboard failure leaves the bounded recovery available for retry.
- Do not synthesize Enter. Do not test against an uncontrolled document, chat, terminal, or privileged application.

**Pass:** an unchanged disposable input receives one Unicode-capable plain-text result exactly once; switching focus before completion and cancelling during processing each produce zero insertion.

### WA06 - Minimum privacy and failure behavior

- Send only transcript text, cleanup instructions, and any already-configured vocabulary to the authorized text-cleanup route. Never send raw audio, surrounding document contents, screenshots, or ordinary typing.
- For the original WA06 acceptance run, history remained off. W07 now retains only validated terminal cleaned output under the encrypted history policy above; temporary audio/raw transcript data is still removed on success, failure, and cancellation paths.
- A processing failure shows `Sorry, not available` (optional sanitized detail is allowed) and inserts nothing.
- Logs and test evidence contain no credentials, private audio, or full private transcripts.

**Pass:** inspect the exercised outbound payloads, temporary files, and visible failure result for the preview scenarios.

### WA07 - Meetings and lectures

- The recording layer remains above other ordinary desktop windows in both compact and expanded meeting modes without becoming focusable.
- When the keep-visible choice is on, the compact layer offers `Start meeting` without activating or focusing the overlay; it is absent during push-to-talk dictation. When the choice is off, idle compact state is hidden and meeting mode remains available through its shortcut and Commands action.
- The configured `Ctrl+Shift+Space` shortcut starts meeting mode. If its `Ctrl+Shift` prefix has already begun push-to-talk dictation, OpenTalk cancels and fully releases that capture before starting the meeting; startup failures remain contained and visible rather than becoming unhandled errors.
- Meeting capture is explicit and locally transcribed from the selected microphone plus the selected Windows playback endpoint through meeting-only WASAPI loopback. Ordinary dictation and Assistant capture remain microphone-only. Live previews are ordered, bounded and stale segment events are ignored.
- Pause/Resume creates ordered local transcript segments. Stop saves raw transcript first, then sends transcript text only for one summary/minutes request.
- During active recording, the bookmark control creates at most 1,000 ordered local markers using recorded time rather than paused wall-clock time. Each saved marker points within the final raw transcript and remains available if summary generation fails; no raw audio is retained for bookmarks.
- The provider request uses the selected account, `store: false`, `stream: true`, an input array and instructions, and accepts output only after `response.completed` plus strict runtime validation.
- Meeting records are encrypted at rest and separate from dictation history. The list uses the short summary; detail uses the long summary, raw transcript and meeting minutes.
- Markdown export writes only the selected record's validated minutes to the user-selected path. The hub renders supported Markdown as inert React elements without evaluating raw HTML, loading remote images, navigating links or executing generated content.
- Dual-source capture, plan usage, summary fidelity, long-duration behavior and native pause/resume remain unverified until attended acceptance on explicitly selected microphone, playback endpoint and account resources.

**Pass:** one attended meeting produces ordered live/final transcript text, survives Pause/Resume, saves and navigates multiple audio bookmarks once, is saved once, receives both summaries and minutes from a completed account response, appears in both supplied views, and exports the exact minutes as Markdown. A provider failure must retain the transcript and bookmarks without claiming an AI summary.

### WA08 - Deterministic voice commands

- Commands are compiled, typed in-product actions with fixed phrases and handlers. Renderer input, transcripts and model output cannot supply an action identifier or executable payload.
- `Start Meeting` matches only the final local transcript after case, repeated-whitespace and terminal-punctuation normalization. Prefixes and utterances with additional words remain normal dictation.
- A matched command skips cleanup, insertion and dictation history. OpenTalk releases the dictation capture before starting meeting capture; cancellation that wins during release prevents the action.
- Commands appears as a hub destination, explains exact matching, lists `Start Meeting`, and offers the same existing meeting-start action as an explicit button.
- Command recognition does not create background listening and does not expand microphone, renderer IPC or provider access.

**Pass:** deterministic tests prove exact-match/rejection behavior, zero cleanup/insertion/history for a match, release-before-action ordering, cancellation suppression and contained startup failure. Attended microphone recognition remains unverified until an authorized tester runs it.

### WA09 - Selected-text assistant

- Observe only an explicit nonempty selection in a supported focused edit/document control. Passive observation must obtain the exact range through UI Automation and perform no keyboard injection, WM_COPY or clipboard mutation; if the provider cannot expose it, offer no Assistant bubble. Keep the selected text in bounded session memory and never add it, the spoken command or generated result to dictation history or diagnostics.
- Render the assistant in its own nonfocusable transparent window. The existing default compact/meeting layer and saved microphone setting remain unchanged.
- Clicking the bubble starts one explicit microphone capture. Its listening presentation matches the default recording pill and adds only a Stop control.
- Send only the captured selected text, final local voice command and fixed transformation instructions through the selected account's existing `store: false`, streamed Responses route. Accept only validated nonempty output after `response.completed`.
- Review output as inert text. `Replace selected text` and `Add after selection` each consume the same one-attempt replacement budget. Incidental focus notifications do not discard the captured copy. At accept, restore the original target if Windows permits it and require the same window/control plus exact selected text through UI Automation or the recorded clipboard fallback. Cancellation, changed text/target, secure/privileged targets and uncertainty produce no retry.
- Assistant hook/window-registration failure degrades only the assistant. Microphone enumeration, manual selection and ordinary dictation remain available.

**Pass:** deterministic coordinator/native tests prove exact-selection revalidation, one-attempt replacement, blocked Copy, cancellation and independent microphone enumeration. Isolated rendering proves the transparent circle, matching listening pill/Stop control and review actions. Real selection, microphone, account-route and target replacement remain unverified until an attended disposable-target run.

## Non-negotiable safety constraints

These constraints remain in force even though release certification is deferred:

- no credential leakage or plaintext token fallback;
- no background/ambient recording;
- no insertion after cancellation or a detected target change;
- no duplicate insertion retry;
- no arbitrary command or tool execution outside the reviewed fixed in-product catalog, synthesized Enter, automatic elevation, or protection bypass;
- no hidden API-key billing, cloud transcription fallback, or private ChatGPT endpoints; and
- no live insertion test in an uncontrolled application.

If the existing implementation cannot prove a safe insertion, the working preview may end by displaying the cleaned result in the app with a clearly labeled manual Copy action. That is an explicit temporary fallback for the preview, not evidence that WA05 passed.

## Deferred until after the working preview

The following items are deliberately **not requirements for the current milestone** and must not delay WA01-WA06:

- hands-free recording, configurable shortcuts, bare-Space behavior, and 30-cycle physical hotkey certification;
- complete settings persistence/migration, launch-at-login, tray polish, full keyboard-accessibility review, and visual polish;
- multiple account/workspace support, restart/refresh endurance, account switching, second-user isolation, and exhaustive revocation edge cases;
- custom vocabulary effectiveness and transcription hints;
- a ten-recording WER suite, the twelve-case three-run cleanup benchmark, formal tone review, and performance percentiles;
- recordings over five minutes, loss-aware chunk cleanup, a 60-minute replay, disk-exhaustion stress, and crash-recovery certification;
- broad insertion compatibility across Edge, Chrome, VS Code, Word, terminals, elevated apps, locked desktops, and complex clipboard formats;
- resumable model downloads, first-run onboarding, installer/clean-VM/uninstall testing, and code signing;
- second-person setup, public naming, distribution licensing, full third-party notice inventory, publication, and release evidence; and
- comprehensive dependency, fuzz, malformed-message, resource-exhaustion, and security certification beyond issues encountered in the active path.

The old R01-R20 ledger was historical release-planning context and no longer defines completion of the working preview. Deferred items can be reprioritized only through the current public task queue or an explicit project instruction.

## Completion label

Passing WA01-WA06 permits the label **working local preview on the tested machine**. It does not permit the labels finished, production-ready, generally compatible, distributable, secure-audited, or installer-ready.
