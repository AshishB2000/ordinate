# AI: providers and models

<sub>[← All operator docs](README.md)</sub>

AI is optional. Everything except the Assistant, drafting, chart suggestions, "explain" and
reading a screenshot works without it. An org admin turns it on in **Admin → AI**; members never
see a key or a connect form.

Ordinate's numbers never come from a model. A model only narrates figures the app computed, or
reads the table out of a screenshot for you to check. See the core principle in the repository's
`CLAUDE.md`.

## What the server needs

| Needed | Why |
|---|---|
| `DATABASE_URL` (Postgres) | Providers, the model list and each member's pick are stored there, so every pod gives the same answer. |
| `ORDINATE_MASTER_KEY` | API keys are encrypted under a per-org data key wrapped by it (envelope encryption, as for connection passwords). |

Without both, Admin → AI says which one is missing and nothing can be connected. There is nowhere
safe to keep a key, so the server refuses rather than writing one in the clear.

A server with no database (`AUTH_MODE=dev`, the test harness) can still use a model already set in
that pod's own `config.json`. That is a single-pod convenience for development, not a setup path.

Provider calls leave the server through the SSRF guard, the same as connectors. An
OpenAI-compatible gateway on a private address needs `SSRF_ALLOW` for its range. See
[configuration.md](configuration.md).

## Admin → AI, step by step

1. **Connect a provider.** Anthropic, OpenAI, Google Gemini, or an OpenAI-compatible gateway
   (OpenRouter, LiteLLM, vLLM, Azure OpenAI behind a proxy, and similar).
   - Paste the API key. The field is write-only: it is never filled in, it is cleared as soon as it
     is sent, and no reply, log line or page ever contains the key again.
   - For the gateway, also give its base URL (for example `https://gateway.example.com/v1`) and a
     model id to test with. Other providers have a base URL under **Advanced**, for a proxy.
   - **Connect** saves the key and makes one small real call. The provider shows *Connected* only
     if that call passes. If it fails, the provider's error appears under the form, the key stays
     saved, and the provider stays off until a test passes.
   - A connected provider offers **Test again**, **Replace key** (save a new key and test it) and
     **Disconnect**. Disconnect deletes the key. The confirmation says how many models members lose.
2. **Add models.** Pick a connected provider. Its live model list loads on the server with the
   stored key. Tick the models your team may use, or type an id the list does not show (a gateway
   model, or a new one). Only models on this list are ever offered or used. A model the provider
   releases tomorrow stays off until you add it, so cost stays in your hands.
3. **Choose the default.** One model is the default. A member who has not picked one gets it.

## What members see

- The Assistant has a model picker under the composer with the models you enabled, the default
  marked. With one model it shows the name only. The pick is saved on the server per person, so it
  follows them to every tab and every AI feature: the Assistant, Home's ask bar, chart suggestions,
  dashboard drafting, explain and screenshots.
- If you remove a member's model or disconnect its provider, their pick falls back to the default.
  Nobody has to fix anything.
- With nothing set up, every AI surface says *"AI isn't set up for your organization yet. An admin
  can turn it on in Admin → AI."* Admins also get a **Set up AI** button there (or, when the server
  has no key store, a line saying what the operator must set).

## Upgrading from a pod-local setup

Before this, everything except the key (which provider was connected, which model, the gateway URL)
was kept in each pod's `config.json`. With more than one pod, a provider connected on one pod was
"not set up" on the others.

The first time an org's AI setup is read after the upgrade, Ordinate imports that block once.
Each provider with a stored key (a gateway: a base URL) that the old **AI providers members may
use** setting allowed comes in with its model. The old active provider's model becomes the default.
`config.json` is not changed. After that the old setting is ignored, and the model list is the
policy.

## Not yet

- Models per role or team, per-person budgets, and usage or cost reports. Ordinate does not record
  token counts yet.
