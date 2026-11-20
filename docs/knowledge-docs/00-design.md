# Knowledge documents for the Assistant

Feature 3 of the 10 Lightdash-parity AI features. Agreed with the owner on 2026-11-19.

## What it is and why

An editor attaches reference documents to a project or to one Assistant agent: "How we count revenue",
the fiscal calendar, what an active customer is, a metrics policy. When someone asks a question, the
Assistant reads the parts of those documents that match it, and uses them to choose datasets, columns,
filters and words. The documents explain the business. **They never supply a computed figure:** the
engine still computes every number, as everywhere else (AGENTS.md core principle).

Instructions (`src/app/instructions.ts`) already hold short standing rules: at most 40 of them, each one
line of up to 300 characters. Documents are for what does not fit there: pages of reference text,
often already written as a PDF or a Word file.

Lightdash's version: `.md` and `.txt` only, 20 KB each, attached per agent or org-wide. The model sees
summaries and opens a document with a tool call.

## Decided by the owner

1. **Both kinds of input:** typed or pasted text (Markdown or plain text), and uploaded **PDF and Word
   (.docx)** files.
2. **Matching passages, not whole documents.** Ordinate's ask makes one model call, with no tool loop,
   so the model cannot stop to open a document. Documents are split into passages, and each question gets
   the few passages that match it, inside the GUIDANCE block of that one call. The two alternatives were
   turned down. Whole documents with a size cap would refuse most real PDFs. Two model calls (pick a
   document, then answer) would make every ask about twice as slow and costly.
3. **One new runtime dependency is approved: Mozilla's PDF reader** (`pdfjs-dist`). Word needs no new
   library code: `jszip` 3.10.1 and `saxes` 5.0.1 are already installed through `exceljs`. They become
   direct dependencies at exactly those versions.
4. Other apps' bots in a Slack channel stay uncounted by the Slack check (feature 2; this does not change).

## Calls made in the design (the owner can overturn any of them)

- **Who may read documents** (rule 3) follows instructions: every reader of the project, or of the agent.
- **Separate tables, not the Assistant's existing search index.** The pitch to the owner said "the
  search the Assistant already uses". Building it showed why not: `assistant_search`'s `kind` filter is
  optional (`RankOptions.kinds`), so every existing caller that passes none, on this release or on a pod
  of the one before during a rollout or a `helm rollback`, would get passages mixed into its datasets
  and metrics. The passages use the same word function (`searchWords`) and the same Postgres-narrows,
  pure-function-ranks pattern, in two tables of their own. Say so plainly in the PR body.
- **Postgres only.** The original file is not kept.
- **No meaning search** in this version.
- **The limits** in the table below.
- **`jszip` and `saxes` become direct dependencies** at their installed versions.
- **Figures from documents stay out of the ledger** (rule 6).
- **The ranking weights and the cut-off** (Passages and matching).
- **The native `@napi-rs/canvas` package is kept from loading** inside the parse worker (Reading files).

## Rules

1. **Where a document lives.** In a project (used by the default Assistant and every agent of the
   project) or in one agent (used only by that agent). This follows instructions: the project's apply to
   every agent (docs/assistant-agents rule 4). An agent's own passages win ties.
2. **Who manages them.** A project document: whoever may change the project's instructions (the same
   contract `access`). An agent's document: whoever may change that agent's instructions (the same check
   as `changeAgentInstructions`).
3. **Who may read them.** The list and the text of a project's documents: every reader of the project,
   as instructions and guides are (src/ipc/guidance.ts, D5). An agent's documents: everyone who may use
   that agent (`mayUse`). The page that manages documents says so in one sentence: *Anyone who can ask
   this assistant can see what these documents say, including in Slack channels connected to it.*
4. **Documents hold no data.** No passage is foldered, row-locked or column-masked, because none comes
   from a dataset. For that reason the Slack case-A/B check does not change: a passage is no shown dataset.
5. **One model call.** Passages go inside the existing `<<<GUIDANCE … GUIDANCE` fence, after the
   instructions and guides and before the verified examples, under their own header:
   `From the project's documents (written by people, not computed by the app). Use them for meaning; every figure still comes from the facts:`.
   Each passage is one line, prefixed `[<title> › <heading>]`. A passage that matches `FENCE_RE` is left
   out (the store refuses none, because a PDF may legitimately contain `<<<`. It just never reaches a
   prompt).
6. **A document's plain numbers join the ledger, its figures do not.** Guidance seals every digit
   (`sealLedger(…, 'guidance')`). Do the same for passages, but first blank out every token
   `FIGURE_RE` matches (src/app/instructions.ts: a currency sign before a digit, a decimal, a thousands
   separator, a percent), using a global copy of that pattern. So "the fiscal year starts on 1 February",
   "a 30-day window" and "FY2025" may be repeated without a note. But "$4.2M", "12.5%" or "1,250"
   quoted from a stale PDF gets the guard's note (`guardAnswer`), exactly as an invented figure does.
   A document may explain a number; it never stands in for one the engine computes.
7. **The answer says what it used.** `TurnGuidance` (src/ai/turnGuidance.ts) gains
   `documents?: string[]`: the UUIDs of the documents whose passages went into the prompt, at most 6,
   kept by its sanitizer the way `examples` are. Ids only, never text or titles. When a turn goes to
   the browser, the server resolves the titles the way `agentRef` resolves agent names, and a document
   deleted since then comes back as gone. "How this was answered"
   (`web/src/features/model/assistant/HowAnswered.tsx` and the dock's equivalent) lists the titles, or
   "a removed document".
8. **Never costs an answer.** As with `askGuidance`, a failure to load or rank passages is logged and the
   ask goes on without them.
9. **Which asks get passages.** Every place `askGuidance` / `guidanceBlock` builds a GUIDANCE block for
   an Assistant answer: `copilot:ask` (the dock, Home, the test chat, and Slack through it), plus any
   other caller found by a grep. List each caller in the PR body, with whether it gets passages and
   why. The MCP surface (`src/automation/verifiedTools.ts`) does not get them in this version.

## Limits

| What | Limit |
|---|---|
| Documents per project (its own and all its agents' together) | 100 |
| Uploaded file | 10 MB |
| Text of one document (typed, or read from a file) | 300,000 characters; longer is refused with a message, never cut silently |
| Title | 120 characters |
| A passage | at most 800 characters |
| Passages per ask | at most 6, together at most 4,000 characters |

## Storage

Postgres only: two new tables in **`0042_knowledge.sql`**. Feature 2's PR (#577) adds `0041_slack.sql`,
and the migration runner refuses a new file numbered below one already applied
(`src/server/db/migrate.ts`). So **#577 merges first**. This PR says so in its body, and develop is
merged into this branch after #577 lands. Confirm locally that the runner and its tests accept the
0040 → 0042 gap on a fresh database.

- `knowledge_docs`: `org_id`, `project_id`, `id` (uuid), `agent_id` (uuid, null for a project
  document), `title`, `source` (`typed` | `markdown` | `text` | `pdf` | `docx`), `file_name` (null for
  typed), `chars`, `text`, `text_hash`, `created_by/at`, `updated_by/at`.
- `knowledge_passages`: `org_id`, `project_id`, `doc_id`, `agent_id`, `ord`, `title_words`,
  `heading_words`, `text_words`, `heading`, `text`, and `words text[]` (GIN index). `words` is the
  union of the document title's, the heading path's and the passage text's words, so a passage found by
  its title alone is still a candidate. Every word list comes from `searchWords` (src/ai/modelWords.ts),
  the function the Assistant search uses: stop words dropped, light plural fold, 64-character cap.
- Forced row-level security on both, through `current_setting('ordinate.org')`, exactly as 0041 and the
  existing tables do. Both join the per-org sweep. A save rewrites the document's passages **in the same
  transaction** as the document row, so a passage never outlives or lags its document.
- **The original file is not kept.** It is read once from the upload staging area (`POST /api/files`,
  single-use `fileToken`), the text is stored, and the staged bytes are deleted. The extracted text is
  shown to the editor and can be edited like a typed document.
- Without `DATABASE_URL` the feature is off: the documents page says it needs a database, and the ask
  adds no passages. This is how every other Postgres-only store (Slack, secrets) behaves.
- Edits follow the edit-conflict pattern agents use (an `updatedAt` tag; a stale save is refused, never
  merged).

## Lifecycle

- **An agent is trashed** (`agent:delete` → `trash.trashRecord`): its documents stay, so a restore
  brings them back, but they are neither used nor listed. They still count toward the 100. **An agent
  purged from the trash for good:** its documents and passages are deleted. Find the purge path and hook
  it in, the way other per-agent rows are handled there. If there is none, say so in the PR body.
- **A project is deleted:** its documents and passages go with it, as the project's other Postgres rows
  do (Slack's 0041 tables are the closest example).
- **The per-org sweep** removes both tables' rows.
- **Project export and import:** if agents travel in an export, documents travel with them. If agents
  do not, documents do not either. Say which in the PR body.

## Reading files

- **The type comes from the bytes, never the name.** A PDF starts `%PDF-`; a .docx is a zip holding
  `word/document.xml`. Anything else, an old binary `.doc` included, is refused with a message naming
  the types accepted. `.md`/`.txt` must be valid UTF-8 (`TextDecoder` with `fatal: true`); a BOM is
  dropped.
- **Both parsers run in a worker thread** (`worker_threads`, following `src/engine/regexWorker.ts`), so
  the event loop never blocks: `resourceLimits` set, a 30-second limit, the worker terminated on timeout
  (it is not a DuckDB worker, so that is allowed). One worker per parse, never pooled across orgs.
- **PDF** (`pdfjs-dist`, pinned to an exact version at least two weeks old, the legacy Node build): only
  `getDocument({ data })`, never a URL, with `isEvalSupported: false` (CVE-2024-4367),
  `disableFontFace: true`, `useSystemFonts: false`, no worker URL fetch, and no network. Text comes from
  `getTextContent()` per page: each item's `str`, a line break on `hasEOL`, and pages separated. An
  encrypted PDF and a PDF with no text (a scan) are refused, each with its own sentence.
- **Spiked on 2026-11-19 with `pdfjs-dist@6.5.438`** (published 2026-11-01, `engines` `>=22.13`; the
  image is `node:24-slim`). In this repo's CommonJS output (`module: NodeNext`),
  `await import('pdfjs-dist/legacy/build/pdf.mjs')` inside a `worker_threads` worker reads a
  hand-made one-page PDF correctly and opens no socket.
  - On import it runs `require("@napi-rs/canvas")`, its optional native package (about 28 MB,
    installed by default), to polyfill `DOMMatrix` and `Path2D` for rendering.
  - Text extraction does not need them. Register
    `module.registerHooks({ resolve })` in the worker *before* the import, refusing any specifier
    starting `@napi-rs/canvas`. Then pdf.js logs one warning, carries on, and no native module is
    loaded. Verified: `require.cache` holds none.
  - The package stays in the lockfile and the image (the Dockerfile cannot omit optional packages:
    DuckDB's platform bindings are optional too). Give the sizes in the PR body.
  - The install needs the npm registry and a temporary npm cache (`npm_config_cache=$TMPDIR/npmcache`;
    the user's own cache has root-owned files). Root `node_modules` in a worktree is a symlink into the
    main checkout, so install from the main checkout's root **only to add the package to
    `node_modules`**: never `git` there. Then write `package.json` and `package-lock.json` in this
    worktree with the exact versions.
- **Word:** check the zip entry's uncompressed size (at most 50 MB) *before* inflating it, which guards
  against zip bombs. Read `word/document.xml` with `saxes`: paragraphs, runs, tabs and breaks, with
  `Heading1`–`Heading6` paragraph styles as Markdown headings and table rows as `a | b | c`. Images,
  comments and tracked deletions are left out.

## Passages and matching

- **Splitting** (pure, `src/knowledge/split.ts`): break at Markdown headings and blank lines, and
  carry the latest heading path (`Revenue › Refunds`) onto every passage under it. Merge small
  paragraphs up to 800 characters, and cut an oversized paragraph at a sentence end (a hard cut only
  when there is none). It is deterministic: the same text always gives the same passages.
- **Ranking** (pure, `src/knowledge/rank.ts`, in the style of `assistantSearchRank.ts`): the question's
  words via `searchWords`. A passage scores 2 for each question word in its document title, 2 for each
  in its heading path, and 1 for each in its text, with words deduplicated per field. A score of 0 is
  never shown.
  - **The cut-off keeps noise out:** a passage is kept only if its score is at least half the top
    passage's (rounded up). Prose shares common words with almost any question, so without this every
    ask would carry 6 weak passages.
  - Ties go to the agent's own document, then the newer document, then `doc_id`, then `ord`, every
    string compared by code unit. The 6 / 4,000 budget is applied in rank order.
  - The weights and the cut-off are a starting point. Tune them only against the retrieval test below,
    and report the final values.
- **Postgres narrows, the pure function ranks.** The query takes the project's passages, plus the
  answering agent's passages, `WHERE words && $1`, and the same pure rank orders them. Because a passage
  sharing no word scores 0, this equals ranking every passage. `test-knowledgeRank` holds the two equal
  with `Object.is`: the house differential style.
- **Short rules belong in instructions.** A one-line rule may not match a question's words. The
  documents page says so, and links to the instructions list.
- Meaning search (fingerprints) for passages is **not in this version**; see "Not in this version".

## Contracts (`src/api/knowledge.ts`, appended to `src/api/index.ts`)

| Channel | Access | What it does |
|---|---|---|
| `knowledge:list` | read | The documents of a project or an agent: id, title, source, file name, chars, updated. Never the text. Filtered by rule 3. |
| `knowledge:get` | read | One document's text (rule 3). |
| `knowledge:save` | write | Create or edit a typed document, or edit a read file's text (rule 2, edit tag). |
| `knowledge:upload` | write | `{ projectId, agentId?, fileToken, title? }`: read the file in the worker and store its text (rule 2). |
| `knowledge:delete` | write | Delete a document and its passages (rule 2). |

Every input is a real zod schema with `project` scope. Ids are validated with `UUID_RE`. `knowledge:list`
and `knowledge:get` return editor prose and no dataset rows, so classify them in
`scripts/rowPolicyReaders.ts` the way the instructions readers are classified. New server sentences go
through `t()`.

## Screens

- **Model → Assistant** (`web/src/features/model/assistant/AssistantTab.tsx`): a **Documents** section
  next to Instructions. It has the list (title, kind, size, last edited by and when), **Add document**
  (a Markdown editor) and **Upload PDF or Word**, a document view showing exactly the text the Assistant
  reads, editing, delete with a confirm, and an empty state that explains what documents are for and
  points short rules to Instructions.
- **An agent's page** (`AgentPage.tsx`): the same section for that agent's own documents. It also shows,
  read-only, a line saying the project's documents apply too.
- **Test chat and "How this was answered"** list the documents used (rule 7).
- Upload states: reading, refused (the sentence from the server), and too long. Use house components
  and CSS Modules. Meet the polish bar: real empty states, no centred boxes, light and dark.

## Tests (every guard with a negative control)

- `test-knowledgeParse`: .md/.txt (invalid UTF-8 refused, BOM dropped), docx (headings, tables, breaks;
  a zip bomb refused before inflating; a .docx renamed .pdf read as docx; a .doc refused), PDF (a small
  committed fixture; encrypted refused; no text refused; a timeout terminates the worker). Prove
  `isEvalSupported` is false, and prove nothing in the parse opens a socket (spy on `net.connect` or
  equivalent).
- `test-knowledgeSplit`: headings carried onto passages, the 800 cap, determinism, sentence cuts.
- `test-knowledgeRank`: the pure scores, the cut-off, the tie order, the budget, and the
  Postgres-narrowed ranking equal to the pure ranking over everything (`Object.is`).
- **`test-knowledgeRetrieval`: does it find the right passage?** Commit a realistic fixture: a metrics
  policy of about 8,000 characters with headings (revenue, refunds, active customers, churn, fiscal
  calendar, regions, and so on), plus one unrelated document. Write about 10 questions in plain words,
  each naming the passage it needs. Each one's passage must be in the kept set, and the unrelated
  document must never appear. As its negative control, a question about something no document covers
  keeps nothing.
- `test-knowledgeBlock`:
  - Passages sit inside the fence, one line each, and a `FENCE_RE` passage is left out.
  - Plain digits are in the ledger and `FIGURE_RE` figures are not.
  - The agent's passages come before the project's on ties, and the block is empty when nothing
    matches.
  - The guard test: a document says "Revenue in 2025 was $4.2M", and a stubbed answer stating $4.2M
    gets `guardAnswer`'s note. The same answer with $4.2M in the facts gets none.
- `test-knowledgeStore` (DB): save, upload, edit tag conflict, delete removes passages, the 100 cap, the
  300,000 cap, RLS forced and tested as an ordinary role (as `test-slackRls` does), and the sweep.
- `test-knowledgeAccess` (DB): a viewer may list and read but not save; another agent's documents are
  never used or listed; an id from another project is refused; documents from another org are invisible.
- `test-knowledgeAsk`: through the **real** registered `copilot:ask` handler with a stub provider, as
  `test-slackAsk` does. The matching passage reaches the prompt and the unmatched one does not; the
  agent's own passages appear only for that agent; the turn records the document ids; and a ranking
  failure still gives an answer.
- Vitest for the Documents section, the upload states and "How this was answered".
- Playwright `web/e2e/knowledge.e2e.ts`: type a document, upload a small .docx and a small PDF, see the
  extracted text, ask in the test chat, and see the document listed under "How this was answered".
  Delete it.
- The full gates: `npm run build:ts`, `npm run lint`, `npm test` with and without `DATABASE_URL`,
  `npm run test:web`, `npm --prefix web run size`, and `check-contracts`.

## Not in this version

- Meaning search (fingerprints) over passages. The words-only search is the baseline every org has,
  because fingerprints are off until an admin picks a model.
- Documents for MCP agents (`/api/mcp`), and org-wide documents shared across projects.
- Scanned PDFs (they would need a model to read the pictures), old `.doc`, `.pptx`, `.xlsx` as a
  document, page numbers on passages, and keeping the original file.
