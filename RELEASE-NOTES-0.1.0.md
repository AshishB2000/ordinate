# Screenchart 0.1.0

**Screenshot any data, get instant AI analysis.** Press a hotkey, drag a box around any chart,
table, or on-screen data, and Screenchart explains it in plain English and turns it into a clean
visualization — without leaving what you're doing.

## Highlights
- **Capture anything on screen** — charts, tables, PDFs, spreadsheets, web content.
- **Plain-English analysis** of what you captured.
- **Clear visualizations** from the data (including maps).
- **Bring your own key** — Anthropic, OpenAI, Gemini, or any OpenAI-compatible gateway
  (OpenRouter / Ollama / custom). Or use a local CLI agent.
- **Local-first storage** — captures, history, and keys stay on your machine. Analysis sends the
  captured image to the provider you choose; see PRIVACY.md.

## Install
macOS build on the [Releases page](https://github.com/AshishB2000/screenchart/releases). The
build isn't code-signed yet, so on first launch macOS shows "Apple could not verify…" —
right-click the app → **Open** to get past it. Full setup in QUICKSTART.md.

## Known issues
- Unsigned build → Gatekeeper warning on first launch.
- Some CLI agents trigger a macOS Automation prompt (safe to deny).
- API keys are stored unencrypted on disk (see PRIVACY.md).

## Notes
- Keep the "Highlights" section handy — paste it into the GitHub release when you push the tag.
