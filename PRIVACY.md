# Privacy

Screenchart is a desktop app that keeps your work on your machine, with one important
exception: AI analysis. This explains exactly what stays local and what leaves.

## What stays on your machine

- **Captures, history, and settings** are stored locally in the app's user-data directory
  (history lives in `userData/history/<threadId>/`).
- **Your API keys** are stored locally in `userData/config.json`.
- **We run no server.** No accounts, no login, no first-party backend receives your data.
- **No telemetry, no analytics, no crash reporting**, and no auto-updater.

### About your API keys — please read
Your API keys are stored in **plaintext** in `userData/config.json`. The file is excluded from
version control, but it is **not encrypted**. Anyone with access to your user account and disk
can read it. Protect your machine accordingly, and revoke/rotate keys with your provider if you
believe the file was exposed.

## What leaves your machine

Screenchart's core feature is AI analysis, which requires sending data off your machine:

- **When you run an analysis with a provider key (BYOK):** the cropped image you captured is
  uploaded (base64, inline) over HTTPS to the provider you configured — Anthropic, OpenAI,
  Gemini, or a gateway (any OpenAI-compatible endpoint, e.g. OpenRouter, Ollama, or a custom
  one) — along with the prompt text. The request goes directly from your machine to that
  provider using your key; it does not pass through any Screenchart server. That data is handled
  under **the provider's own privacy policy and terms**.
- **When you run an analysis via a local CLI agent:** the cropped image is written to a temporary
  file on your machine and the local agent process reads it. The agent runs locally, but whatever
  network behavior that agent has (e.g. calling its own model API) then applies.
- **Model list lookups:** when you select or refresh available models, the app queries the
  provider's endpoint.
- **Maps:** if a visualization renders a map, map tiles are fetched from OpenStreetMap.

If you never run an analysis (and never render a map), nothing is sent.

## Screen Recording permission (macOS)

Screenchart requests macOS Screen Recording permission because capturing a screen region requires
it. It captures **only the region you select, only when you trigger a capture** — it does not
continuously record, stream, or monitor your screen.

## Provider privacy policies

Because your capture is sent to the provider you choose, their policy governs that data:
- Anthropic (Claude): https://www.anthropic.com/legal/privacy
- OpenAI: https://openai.com/policies/privacy-policy
- Google (Gemini): https://policies.google.com/privacy
- For a gateway/custom endpoint (OpenRouter, Ollama, etc.), the operator of that endpoint's
  policy applies.

## Contact

Questions about privacy: <!-- TODO(ashish): contact email -->
<!-- TODO(ashish): public privacy URL (site /privacy) once the canonical domain is confirmed -->
