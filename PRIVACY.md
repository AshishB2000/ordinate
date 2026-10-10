# Privacy

Ordinate is software you run yourself. There is no Ordinate cloud, no account with us, and no
server of ours that your data passes through. This page says what stays inside your deployment and
the few things that leave it.

## In short

| | |
|---|---|
| **Telemetry, analytics, crash reports** | None. Ordinate never phones home. |
| **Update checks and run-time downloads** | None. The image carries everything it needs. |
| **Your data and dashboards** | In your Postgres and your bucket or volume. |
| **Passwords and API keys** | Encrypted at rest, never sent to a browser, never written to a log. |
| **What leaves your network** | Only what you set up: your data sources, an AI provider if an admin connects one, and map tiles. |

## What stays in your deployment

- **Your data.** Imported tables are Parquet files in your S3 bucket or volume. Users, roles,
  dashboards, analyses, comments, the audit log and jobs are in your Postgres.
- **Secrets.** Connection passwords and AI provider keys are encrypted under your
  `ORDINATE_MASTER_KEY` before they are stored. They are write-only: no page, reply or log line
  shows one again.
- **Logs and metrics.** Written to the container's output and to the `/metrics` port, for your own
  tooling. Secret fields are redacted from the log.

## What leaves your deployment

Nothing leaves unless someone in your organization sets it up.

### Your data sources

When you add a connection, the server connects to that database, warehouse or API to read from it.
Connections are read-only. A **Live** dataset sends each question to your warehouse as SQL instead
of copying the rows.

### An AI provider, if an admin connects one

AI is off until an admin connects a provider in **Admin → AI** and approves models. After that,
when someone uses an AI feature, the server sends a request to that provider (Anthropic, OpenAI,
Google Gemini, or the OpenAI-compatible gateway you chose). It contains:

- the person's question or the task (for example "suggest a chart");
- facts about the dataset: its name, column names and types, the figures and statistics Ordinate
  calculated, and up to five sample rows;
- for **Read a screenshot**, the image that was uploaded.

When an admin adds models, the server also asks the provider for its list of models.

Columns you mark as personal or financial keep their statistics, but their sample values and
most-common value are sent as "(withheld)".

The request goes straight from your server to the provider, using your organization's key. What the
provider does with it is covered by its own terms:

- Anthropic: <https://www.anthropic.com/legal/privacy>
- OpenAI: <https://openai.com/policies/privacy-policy>
- Google: <https://policies.google.com/privacy>
- A gateway (OpenRouter, LiteLLM, a self-hosted model, and so on): whoever operates it.

To keep data fully inside your network, point the gateway at a model you host yourself, or leave AI
off. Every non-AI feature works without a model.

### Map tiles

When someone opens a map, **their browser** fetches background tiles from OpenStreetMap
(`tile.openstreetmap.org`). OpenStreetMap sees that browser's IP address and which map area was
requested. It receives none of your data: the values and shapes drawn on top come from your own
server.

## Sign-in

- **Single sign-on:** Ordinate receives the email address and name your identity provider sends,
  and stores them in your Postgres.
- **Password sign-in** (for trying Ordinate out): passwords are stored only as salted scrypt
  hashes.

Session cookies are scoped to your Ordinate address. There are no third-party cookies and no
tracking scripts.

## Published dashboards

A published dashboard is visible only to signed-in members of your organization, unless an admin
turns on public links. With public links on, anyone who has a dashboard's link can open it.

## Questions

Open an issue at <https://github.com/AshishB2000/ordinate/issues>. To report a security problem,
follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
