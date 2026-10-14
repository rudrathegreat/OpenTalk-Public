# OpenTalk: subscription connection check

This is a development proof of concept, not the dictation application or an installer. It verifies whether your own ChatGPT account can authorize a local personal app and complete one text-cleanup request using your plan.

## Run on Windows

1. Install Node.js 22 or later from https://nodejs.org if necessary.
2. Extract this folder and double-click `run-check.cmd`.
3. Your browser opens ChatGPT sign-in. Select your account/workspace and review the permission to use your ChatGPT plan.
4. Return to the test window. Success requires both permission validation and a completed inference result; a successful browser login alone is insufficient.
5. Inspect the cleaned sample. It should preserve **Thursday afternoon** and **the graphs we discussed**, remove fillers, and apply the Friday-to-Thursday correction.

The request consumes a small amount of your plan allowance. It does not use an API key or separate API-key billing. No microphone, global hotkey or paste action is enabled.

Optional commands, run in this folder:

```powershell
node login-check.mjs --self-test
node login-check.mjs --manual
node login-check.mjs --model MODEL_SLUG_FROM_THE_AVAILABLE_LIST
```

`--manual` displays a fresh authorization URL if automatic browser launch does not work. Do not share that URL. The script selects the first visible model unless you supply an available slug. This is a connectivity check, not a model-speed benchmark.

## What is saved

Only an opaque host ID and the issued client registration ID are saved under `%LOCALAPPDATA%\OpenTalkLoginCheck\registration.json`. No access, refresh or ID tokens are written to disk or printed. Tokens exist in memory for this one run. At the end, the script attempts to revoke its temporary renewable session. If revocation cannot be confirmed, it says so; you can disconnect **OpenTalk Login Check** in ChatGPT settings. Registration metadata is retained so another run reuses the registration.

This prototype has a single account registration. To use another account/workspace, disconnect the test app and remove its registration metadata first. The production application now has source for a separate account picker, protected credential persistence and serialized token renewal using an independently authored implementation of the documented direct flow. That production lifecycle still needs live validation.

## Verification status

**Result on 30 September–1 October 2026:** the hardened script passed JavaScript syntax checking and **14 offline self-tests** (up from the original 10). One attended live run on the selected Windows account validated ID-token identity, separately granted plan-usage permission, account model discovery and a successful `response.completed` rewrite using `gpt-6-astra`. The returned sample preserved **Thursday afternoon** and **the graphs we discussed** and applied the Friday-to-Thursday correction. The temporary renewable session revocation returned success, and no tokens were saved. This is one feasibility sample, not production GUI account lifecycle, C01–C12 semantic acceptance, microphone capture or automatic insertion. Eligibility and model availability can change. The self-test mode still performs no login or plan-usage request.

The probe was hardened to reject callback replay, bound JSON/stream/JWT/output size, require an explicit successful terminal status and print a redacted top-level failure. It stores registration metadata under `OpenTalkLoginCheck`, separate from production OpenTalk account data. A new live check is opt-in and uses the chosen account's plan allowance.

## Official references

- Registration: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- Inference: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- Limitations: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- Sessions and revocation: https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- Electron devkit example: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt

Documentation checked 30 September 2026. The current plan-usage route excludes audio inputs and transcription. This test therefore exercises text rewriting only.
