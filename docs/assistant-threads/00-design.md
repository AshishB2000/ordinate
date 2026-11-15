# Assistant conversations in their own tables — design

Branch `feat/assistant-threads-tables`, built on `fix/copilot-thread-lock` (it changes the same
file). Migration **0023**. Code: `src/ai/copilotRows.ts`, the switch in `src/ai/copilot.ts`.
Then `feat/assistant-thread-paging` (migration **0025**, §8): no cap of 50 with a database, a paged
list, and an org retention setting.

## What you will see

- **Nothing changes on screen.** The conversation list, its order, the titles, rename, delete,
  "Clear history" and the limits (50 conversations per member per project, 200 turns each) are
  the same. You still see only your own conversations. (Since §8, with a database, conversations
  are no longer capped at 50: the list loads 50 at a time, with "Load more".)
- **Asking is no slower in a busy project.** Saving a turn used to read and rewrite every member's
  conversations in the project. With one member at the limits (a 7.8 MB `copilot.json`), an
  append took **75 ms**; it now takes **1.4 ms** (local Postgres 17, median of 20).
- **A busy project no longer stops saving.** All members' conversations shared one record capped at
  8 MiB. Once it was full, every member's next question failed to save ("This is too large to
  save"); two members at the limits are past it. Each member's conversations are now their own rows.
- **Two members asking at once never wait on each other.** One member's writes in a project still
  run one at a time, which is what keeps a bare append in the conversation the last one made.
- **On upgrade**, the first time anyone opens or asks in a project, its `copilot.json` moves into the
  tables (152 ms for the 7.8 MB one, once). Nothing is lost and nothing asks the user anything.
- **Without a database** (dev mode) nothing changes: `copilot.json`, as before.

## 1. Why

`projects/<id>/copilot.json` is one row of `records` (0007) holding every member's conversations.
Each turn read it, parsed it, changed one conversation and wrote the whole text back, under the
record lock `fix/copilot-thread-lock` adds. So the cost of a turn grew with everyone's history, two
members' questions queued on one lock, the 8 MiB record cap (`OTHER_RECORD_MAX_BYTES`) was a
project-wide ceiling, and nothing could ask "my conversations, newest first" without reading all
of them. Comparable products keep a row per conversation and per message: Lightdash's `ai_thread` and
`ai_prompt`, Open WebUI's `chat`, LibreChat's `conversations` and `messages`.

## 2. The tables (`0023_assistant_threads.sql`)

```
assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at, touched)
  PRIMARY KEY (org_id, project_id, id)
  INDEX (org_id, project_id, owner, updated_at DESC, touched DESC)     -- my conversations, newest first
assistant_turns (org_id, project_id, thread_id, id, seq, role, text, created_at, body)
  PRIMARY KEY (org_id, project_id, thread_id, id)
  UNIQUE INDEX (org_id, project_id, thread_id, seq)                     -- one number per turn, read in order
  FOREIGN KEY (org_id, project_id, thread_id) → assistant_threads ON DELETE CASCADE
```

Both have forced row-level security on `ordinate.org`, as 0020 and 0022, and every statement names
its org too (`src/server/db/inOrg.ts`). Where this departs from the proposed shape, and why:

- **`project_id` is in every key.** A conversation id is unique within its project only: every
  desktop v1 file migrated into the same fixed id (`V1_THREAD_ID`).
- **`touched`** (a sequence, taken on each create and each append) is the file's array order. It
  breaks an `updated_at` tie, which is the common case (a question and its answer land in the same
  millisecond), and it decided which conversation the 50-per-member cap dropped: the least recently
  touched, as before. `updated_at` alone cannot do either. Since §8 there is no such cap, and
  `touched` is the second half of a page's cursor.
- **`owner` may be NULL**: a desktop import's conversation, which belongs to nobody on a server today
  and stays that way. It is moved, not dropped.
- **`body` is text, not jsonb.** It holds the turn's other fields (provenance, answer spec, suggest,
  learn, savedVisualId, guidance) as the JSON they are today, and is sanitized again on every read
  by the file store's own `normalizeTurns`. jsonb would refuse a `\u0000` inside any of them.
- **`seq` is unique within its conversation.** An append numbers its turn highest + 1 while it holds
  the conversation's row `FOR UPDATE`; the index makes a writer that skipped that fail instead of
  numbering two turns alike, and serves the turn list and the 200-turn cap in index order. The move
  numbers a file's new turns the same way, after the conversation's own.
- **`text` and `title` are columns**, so a later search over conversations reads them directly.
  Postgres text cannot hold a NUL character, so one becomes U+FFFD on the way in (§5).

## 3. Moving `copilot.json`: on first touch, not in SQL

**Not in SQL, because it cannot see the data.** `records` has forced RLS, and the migrator runs as
the app's ordinary role with no `ordinate.org` set: `SELECT … FROM records` in a migration returns no
rows. Getting round that means turning RLS off inside a migration. And a SQL copy would also have to
re-implement the file store's sanitizer, survive bodies that are not JSON or not valid times, and
would miss every turn an older pod writes while the rollout runs.

**On first touch instead** (`moveFile` in `copilotRows.ts`). Every public function, in table mode,
first reads `projects/<id>/copilot.json`. After the move that is one primary-key miss. When the
record is there:

1. Take the record's lock (`recordFs.locked`), read it again, and parse it with the file store's own
   `normalize()` (v1 files, junk fields, caps: what every read did).
2. Insert its conversations in stored order and its turns, `ON CONFLICT DO NOTHING` on the file's
   own ids, cap each owner at 50 as the file was, and delete the record: **one transaction, the
   lock's own** (`recordFs.heldClient`), so the rows and the delete commit together. Everything else
   that takes that lock runs wholly before or after: an older pod's write of the file, another
   move, and "Clear history" (which a project delete runs). A move half done when a clear arrives
   therefore never brings the cleared conversations back (`test-copilotRows`, with its negative
   control).
3. A later call that finds the record again (an older pod wrote it after the move) moves that one
   the same way; what is already in the rows stays.

A record that is not JSON, or past its limits, is renamed `copilot.json.corrupt` and read as no
conversations. The file store skipped it too, then wrote over it on the next turn. Any other
failure is logged and tried again on the next call; the Assistant keeps working on the rows.

## 4. What stays the same

| Behaviour | File | Rows |
|---|---|---|
| A member sees only their own | `mine()` filter | `owner = ctx().user.email` in every statement |
| Most recent, and its tie-break | max `updatedAt`, ties to the last array entry | `ORDER BY updated_at DESC, touched DESC` |
| A bare append targets the most recent, else a new conversation | under the record lock | under an advisory lock per (org, project, owner) |
| An unknown or another member's thread id | falls back to the caller's most recent | the same: `ORDER BY (id = $4) DESC, …` |
| 200 turns per conversation, newest kept | `slice` | delete `seq <= seq − 200` |
| 50 conversations per member, least recently touched out | `capThreads` | none since §8: every one kept, the list paged |
| Title from the first user turn still kept, until named | `titleFromTurns` | the same function, on the kept turns |
| Rename is not a touch | | `updated_at` and `touched` left alone |
| "Save as visual" marks its turn | `markSaved` | the same checks, the turn's `body` rewritten |
| Clear history: everyone's, in the project | `rm copilot.json` | `rm` (under its lock, so no move brings it back), then delete the rows |
| An append in flight never undoes a clear or a delete | record lock | the append holds its conversation `FOR UPDATE`; a delete waits, then cascades |

`loadThreads` still returns every member's conversations in stored order (tests use it), and every
reply carries the same fields in the same order: the turns go through the same sanitizers.

## 5. What changes

- **Deleting a project deletes its conversations.** They used to go with its folder; now
  `projects:delete` calls `clearHistory` beside the secrets, the masking key and the grants.
- **A database error is an error.** The file store read an unreadable record as "no conversations",
  and its next append then wrote over it. The rows refuse instead, in the catalog's words ("This
  could not be read. Try again in a moment." or "…saved…"), with the database's own text in the log
  only: the Assistant's handlers reply with an error's message, and Postgres text never reaches a
  reply.
- **A NUL character in a turn or a title is stored as U+FFFD**, and a lone UTF-16 surrogate as U+FFFD
  too (Node's UTF-8 encoding). The file kept both, escaped in JSON.
- **A stored time that is not canonical** (`2026-01-01`, an offset) comes back as the same instant in
  `toISOString()` form. Every time the app wrote is already in that form, so the move changes none.
- **A turn an older pod adds during the rollout** to a conversation already moved joins it, but the
  conversation keeps the place it had when first moved. One the older pod adds after the file is gone
  starts a new conversation (that pod sees none), which is moved in next.

## 6. Rolling out and rolling back

- **Out:** 0023 only adds two tables and a sequence. New pods move each project on first touch;
  older pods keep writing `copilot.json` until they are gone, and each write is moved by the next call.
- **Back:** the older release reads `copilot.json` only, which no longer exists for a moved project,
  so it shows no conversations. They are not lost: the rows stay. Upgrading again shows them, and
  moves in whatever the older release wrote meanwhile. Operator note: [upgrade.md](../server/upgrade.md).

## 7. Tests

- `scripts/copilotStoreChecks.ts` (a helper): the store's rules (turn ids and times, provenance,
  the same-millisecond tie-break under a frozen clock, threads and their titles, targeting, both
  caps, rename, delete, clear, the per-member cap). `test-copilot-threads` runs it on the file;
  `test-copilotRows` on the rows.
- `test-copilotRows` (Postgres only; the real app on a scratch database): isolation directly and
  over RPC; the move differential (the file store's views against the rows' views, every field with
  `Object.is`; NEGATIVE CONTROL: one changed field or one dropped turn is caught); an older pod's
  file moved again; a corrupt file kept aside; a clear during a half-done move (NEGATIVE CONTROL:
  without the record lock the conversations come back); an append writes no record (NEGATIVE CONTROL: the file
  store does); NUL text (NEGATIVE CONTROL: Postgres refuses it raw); `projects:delete`; a dead
  database answered in the catalog's words (NEGATIVE CONTROL: its own text is different); forced RLS as
  an ordinary role.
- `test-copilotThreadLock`: its Postgres leg is the rows now. 2 members × 25 concurrent appends keep
  all 50 turns, one conversation each. NEGATIVE CONTROL: with the owner lock off, a member's turns
  split across several conversations.

## 8. Every conversation kept, the list paged, an org retention setting (0025)

**Why.** The 50 per member existed because the file store read and rewrote every member's
conversations on every turn (the comment on `MAX_THREADS`). With a row per turn an append costs the
same with 50 conversations or 5,000, so deleting a member's 51st oldest was a cost with no reason
left. Comparable products keep AI threads until an admin says otherwise: Lightdash keeps them, with
an optional retention window.

**With a database:**

- **No count cap.** `capThreads` is gone from the rows; nothing is deleted when a member starts a
  conversation. `MAX_TURNS` (200 per conversation) stays: a model replays a conversation's turns, so
  that one bounds a prompt, not storage.
- **`copilot:threads` returns one page** (`THREAD_PAGE` = 50) and `next`, the cursor of the page
  after (null on the last). The input takes that cursor as an optional `cursor`; the reply keeps its
  fields and adds `next`, so an older client still gets the newest 50. The cursor is the last row's
  `updated_at` in microseconds and its `touched` (`<µs>.<touched>`); the contract refuses anything
  else. The next page is `(updated_at, touched) < (cursor)`, a keyset on `assistant_threads_mine`,
  never OFFSET. A conversation touched between two pages moves to the top of page one instead of
  shifting what page two shows, so a walk through the pages has no duplicate and no gap.
- **Nothing reads the whole list to find one conversation.** `copilot:history`, `copilot:ask`,
  `answer:rerun`, `plan:start` and `agent:list` asked "is this thread one of mine, and which agent is
  it with?" by listing every conversation; they now look up the one thread: `copilot.threadFor` (the
  named one when it is the caller's, else their latest, with its agent) and `copilot.agentOf` (the
  agent of exactly that one, never the latest's).
- **The web** (`useThreads` is a TanStack infinite query) shows the first page in the dock's History
  and on the Assistant page, and "Load more" under it while there are more, with that page's own
  loading rows and error. The title search filters the conversations loaded so far, and says so
  when older ones are not loaded yet.

**Retention.** Admin → Settings, *Delete conversations unused for (days)*: empty, the default, keeps
every conversation; otherwise 1 to 3650. It is `org_settings.assistant_retention_days` (0025),
beside the org's other Admin → Settings values, written by `admin:saveSettings` (an optional field:
absent keeps what is stored, null clears it). The shared sweep (`src/server/sharedState.ts`, every 5
minutes, one pod per org) runs `copilotRows.pruneUnused`: it deletes the org's conversations whose
`updated_at`, the last turn, is older, 100 per transaction (each with at most 200 turns, by cascade),
at most 20 transactions a pass. `FOR UPDATE SKIP LOCKED` passes over a conversation an append is
writing; it goes on the next pass if it is still old. A new index, `assistant_threads_unused
(org_id, updated_at)`, serves it.

**Without a database** (`copilot.json`, `AUTH_MODE=dev`): unchanged. The file is still read and
rewritten whole, so `MAX_THREADS` (50 per member) stays, and it is always one page (`next` null).
There is no jobs table, so the retention setting does not apply there.

**Rolling back** to a 0023 release: its `capThreads` runs again on a member's next new
conversation and deletes all but their 50 most recently touched in that project. Operator note:
[upgrade.md](../server/upgrade.md).

### Measured (local Postgres 17, `EXPLAIN (ANALYZE, BUFFERS)`)

One member with 5,000 conversations in a project, 20 others with 1,000 each (25,000 conversations,
150,000 turns), the exact statement `listPage` sends:

| Query | Plan | Time | Buffers |
|---|---|---|---|
| First page (51 rows) | Index Scan on `assistant_threads_mine`, `Index Cond` on org, project, owner | 0.33 ms | 463 |
| Last page (page 100, cursor after row 4,950) | the same scan, `ROW(updated_at, touched) < ROW(…)` in the `Index Cond` | 0.24 ms | 455 |
| The same depth with OFFSET 4950 (not used) | Bitmap scan of all 5,000 rows, then a sort | 0.95 ms | 171 |
| Retention, nothing to delete, with `assistant_threads_unused` | Index Scan, 0 rows | 0.008 ms | 2 |
| The same without that index | Seq Scan of every org's 25,000 rows | 2.9 ms | 353 |
| One batch: 100 conversations and their 600 turns | Delete + the cascade trigger | 1.1 ms | 706 |

Almost all of a page's buffers are its 50 turn counts (an index-only scan each). A keyset page costs
the same at any depth; OFFSET reads and sorts every row before it. Without its index the sweep
would read the whole table, every org's rows, every 5 minutes for each org that sets a window.

### Tests

`scripts/test-copilotPaging.ts` (Postgres only): 60 conversations of one member page 50 + 10 in
the index's order with no duplicate or gap, through `updated_at` ties and 1 µs steps, the boundary
inside a tie, every field equal to the whole list (NEGATIVE CONTROLS: a cursor without its tie-break,
or cut to the millisecond, leaves a gap the check catches); another member's conversations never in
those pages; the 60th still opens by id with its agent (NEGATIVE CONTROL: another member's id
resolves to the caller's latest, whose agent `agentOf` never reports); a malformed cursor refused (400); the setting stored, kept, cleared, range-checked and
admin-only; the sweep deletes only what is older than N days, with its turns, only in its org
(control: that org's own pass deletes its old one), never waits on a held conversation, and clears a
backlog of 250 in one pass; unset, it deletes nothing. `scripts/copilotStoreChecks.ts`: the file
store still caps at 50 and is one page; the rows keep all 55 and page them.
