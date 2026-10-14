# Coding-agent instructions

These instructions apply throughout this repository. Implement the active requirements in [REQUIREMENTS.md](REQUIREMENTS.md) using the applicable design in [ARCHITECTURE.md](ARCHITECTURE.md). Maintain useful, factual continuity in [SCRATCHPAD.md](SCRATCHPAD.md), and use [TASKS.md](TASKS.md) as the current public execution queue. Historical milestone IDs describe prior implementation work; they do not override the current queue or explicit task instructions.

## Start and finish every work session

1. Read this file, the current scratchpad and TASKS.md. Read the requirements and architecture sections relevant to the task before editing. If the latest explicit instruction limits the session to documentation, honor that scope.
2. Inspect Git status and existing files. Preserve unrelated user changes. Identify the WA requirement and W task affected by the work.
3. Verify current official documentation for the integration you are about to implement. The ChatGPT plan route is a preview; ordinary API examples may not work unchanged.
4. Make a small plan for substantial work. Implement a reviewable vertical slice rather than disconnected placeholders.
5. Run the checks that address the changed behavior. Use mocks for deterministic tests and distinguish them from live acceptance evidence.
6. Update the scratchpad with the outcome, commands, unresolved issues and next action. Update architecture or requirements if an authorized decision changes them. Do not resume a deferred release item unless the current queue or an explicit instruction restores it.
7. Report what changed, why, what passed, and what remains unverified. Never present a scaffold, simulation or browser login alone as a completed end-to-end feature.

The user's explicit instructions take precedence over these project defaults. Resolve routine, reversible implementation choices autonomously. Seek clarification only when a missing answer materially changes product behavior or prevents progress. Do not silently widen data collection, change billing, weaken acceptance criteria, or redesign the platform target to make tests pass.

## Coding principles

- Keep TypeScript strict. Avoid `any` at trust boundaries; validate runtime payloads and model external input as `unknown` until validated.
- Use small cohesive modules with explicit interfaces. Keep UI code, session coordination, auth, cleanup, transcription and Windows automation separate.
- Make side effects injectable. Clock, network, credential store, transcription engine and insertion adapter must be replaceable in tests.
- Every dictation has a unique session ID, monotonically ordered events, an explicit lifecycle, and an insertion attempt budget of one. Ignore stale events after cancellation or completion.
- Use bounded queues and buffers. Do not put unlimited audio, transcript data or model output into memory. Never silently truncate the user's meaning.
- Do not block the renderer or keyboard-hook thread. Heavy model inference belongs in the transcription worker; audio and IPC processing run off the hook callback.
- Use typed errors with stable codes. Product errors are concise; support diagnostics are redacted. Avoid broad exception swallowing and automatic retries that duplicate insertion or consume unbounded plan usage.
- Handle cancellation, process death, application exit, device removal and interrupted downloads explicitly. Cleanup paths must release the microphone and keyboard hooks.
- Write settings atomically with schema versions and safe migration. Persist selected models and hotkeys without making unavailable choices fatal at startup.
- Document commands that actually exist. Add reproducible lint, type-check, unit, native and packaging scripts as their implementations arrive; do not fabricate successful command output.
- Lock dependency versions and native revisions. Keep generated binaries and downloaded models out of source control. Include required third-party notices when packaging.
- Prefer the smallest dependency that meets the need. Do not add a web backend, database, agent framework, tool execution layer or hosted service for this local product.

## Cybersecurity and privacy rules

### Electron and GUI

- Load trusted packaged local UI. Disable Node integration in renderers, enable context isolation, use sandboxing where compatible and define a restrictive Content Security Policy.
- Expose a narrow `contextBridge` API. Never expose raw `ipcRenderer`, arbitrary filesystem access, generic HTTP requests, process spawning or credential getters.
- Validate IPC sender identity, frame origin and argument schemas in the main process. A TypeScript type is not runtime authorization.
- Block unexpected navigation and new windows. Only allow explicitly approved HTTPS destinations for browser sign-in, usage management and help. Treat OAuth query strings as sensitive.
- Render transcripts and model output as text. Do not evaluate HTML, JavaScript, Markdown commands or shell snippets generated by the model.

### Authentication and subscription access

- Use the documented local Sign in with ChatGPT flow or reviewed official devkit. Do not scrape the ChatGPT UI, reuse browser cookies, copy Codex credentials, or call private `backend-api` endpoints.
- Generate fresh PKCE, state and nonce for each attempt. Bind a loopback callback to `127.0.0.1`, validate state, and exchange with the exact callback URI and issued client ID.
- Validate ID-token signature, issuer, audience, expiry and nonce; verify the granted plan-usage permission separately. Keep account/workspace registrations and host identifiers separate.
- Store tokens using Windows-protected storage in the main process. No plaintext credential fallback. Tokens must never enter renderer state, browser storage, logs, scratchpad entries, crash reports, commits or support exports.
- Serialize refreshes per registration; persist rotating refresh tokens atomically. On sign-out, stop requests, attempt documented session revocation, clear local credentials, and report unconfirmed remote revocation accurately.
- Discover models for the selected account. Send only supported request fields. Use `store: false`, `stream: true`, an `input` array and `instructions`/developer messages on the documented HTTP route.
- Accept output only after a successful `response.completed` terminal event and nonempty validation. Failed, incomplete, interrupted and canceled streams never reach automatic insertion.
- Never silently use an API key or charge another provider. No cloud transcription fallback is authorized by this product specification.

### Audio, text and application access

- Dictation and selected-text Assistant sessions capture only the selected microphone. An explicitly started Meeting session may additionally capture only the user-selected Windows playback endpoint through WASAPI loopback so remote participants rendered by Teams, Zoom, Google Meet and similar applications reach local transcription. Stop, pause, cancellation, disable, device loss and quit must close both streams. Do not capture playback outside an active Meeting session, enumerate application audio sessions, or record arbitrary keystrokes, screenshots or clipboard history.
- Scope hotkey handling to configured shortcuts. Never persist ordinary typing. Ignore the helper's own injected input to avoid recursion.
- Transcripts, vocabulary, raw audio and model results are sensitive. Do not send them to analytics or put them in diagnostic logs. Cleanup requests contain the transcript, required cleanup instructions and configured vocabulary only.
- History defaults to off. Temporary files are bounded, private to the current Windows user where the filesystem supports ACLs, and removed on success, failure, cancellation and next-launch crash cleanup. Deletion is not a promise of forensic secure erasure.
- Do not harvest surrounding document contents or selected text. Minimal focus identifiers are used only to guard insertion, not to build an application activity history.
- Validate the destination immediately before insertion. Never paste into a newly focused unrelated field, detected password/secure field or locked desktop. Abort rather than attempting to bypass Windows integrity protections.
- Do not synthesize Enter, execute dictated commands, submit forms, or elevate the application automatically. Use purpose-built test windows for automation tests, not uncontrolled user applications.
- Preserve supported clipboard formats where practical. Restore only if the clipboard still belongs to this insertion; never overwrite a newer user copy. Do not retry a paste merely because acknowledgment is uncertain.

### Native processes, downloads and dependencies

- Spawn trusted, bundled binaries with argument arrays and shell execution disabled. Dictated text, filenames or settings must never become executable shell source.
- Use private inherited pipes for native IPC. If named pipes are required, apply current-user ACLs and endpoint authentication. Do not expose the helper or inference worker over a network listener.
- Validate message versions, types, session IDs, sizes and permitted paths. Do not pass OAuth tokens to native capture/insertion or transcription workers.
- Download models from reviewed HTTPS sources, enforce an expected checksum from a pinned manifest, write atomically, and reject mismatches. Never execute downloaded model data. Bundle native binaries from pinned verified builds.
- Keep TLS verification enabled; bound network timeouts and redirects. Use documented trusted endpoints; never follow credential-bearing redirects to arbitrary origins.
- Check dependencies for applicable vulnerabilities and licensing problems. Address relevant findings or document a bounded mitigation; do not blindly apply breaking automated upgrades.
- No automatic update mechanism is required for the MVP. Any future updater must verify signed packages before executing them.

## Testing and evidence

Meaningful automated coverage is required for changed behavior. During the working-preview milestone, prioritize state transitions, cancellation, stale events, insertion guards, duplicate-paste prevention, completed stream handling, and the real vertical slice. Refresh endurance, broad fidelity certification, stress suites, and full compatibility testing remain deferred unless a change directly affects them. Do not write tests that merely repeat implementation constants.

Use controlled synthetic recordings and transcripts; never commit real credentials or private user recordings. Native automation tests must be opt-in, clearly labeled and restricted to disposable test targets. Live subscription tests run with an explicitly chosen test account and incur plan usage; never run them in an unattended default suite.

For current cleanup evaluation, preserve semantic assertions rather than demanding exact strings. At least one correction or constraint must survive the working-preview samples. The larger multi-case semantic suite remains deferred.

On a non-Windows runner, complete documentation, pure logic, protocol and mocked checks. Report native acceptance as **blocked/unverified**, not passed. Never lower a release gate because the current environment cannot execute it.

## Scratchpad discipline

Record evidence and short rationale, not internal deliberation. Each durable decision names alternatives, consequence and affected requirement IDs. Each failed experiment includes reproduction steps, a redacted result and a next action. Separate assumptions, verified facts and unresolved questions.

Keep the current handoff at the top. A passed WA01-WA06 milestone may be called a working local preview on the tested machine; it must not be called finished, production-ready, distributable, or broadly compatible. Never erase failure history solely because a newer approach succeeded; add a resolution reference.
