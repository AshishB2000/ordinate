---
name: e2e-run
description: Use when running Ordinate's Playwright e2e specs (web/e2e/*.e2e.ts) locally, when one fails (an RPC budget, a console error, a CSP violation, a locator timeout), or when a spec is flaky in CI or the nightly.
---

# Run and diagnose an e2e spec

Each spec in `web/e2e/` starts the **built** server on a temp `DATA_DIR` seeded with the sample
project, signed in as `dev@local`, and fails on any console error, page error, CSP violation, or
a page load over its RPC budget (`web/e2e/fixtures.ts`). One spec file per screen, named after
it (`dashboards.e2e.ts`, `row-access.e2e.ts`).

## Run one spec

1. **Build both halves first, and again after every change.** The harness runs what is built,
   not your source. It only checks that the build exists, so a stale `web/dist` quietly tests
   the old UI.

   ```bash
   npm run build:ts
   npm --prefix web run build
   ```

2. **Run it with the Bash sandbox off** (Playwright cannot launch a browser inside it):

   ```bash
   E2E_NO_BUILD=1 node --test --test-reporter=spec web/e2e/dashboards.e2e.ts
   ```

   - `E2E_NO_BUILD=1`: without it, some specs (`password`, `auth`) run both builds themselves.
   - No browser? `npx playwright install chromium`, or point `E2E_CHROMIUM` at a Chromium binary.
   - One test in a file: add `--test-name-pattern="New → Dashboard"`.
   - Another engine: `E2E_BROWSER=firefox` or `webkit`. CI runs Chromium only; the nightly runs
     the other two.
   - Type-check the specs: `(cd web && npx tsc --noEmit -p tsconfig.e2e.json)`. The full
     `npm --prefix web run e2e` does this, then runs every spec one at a time.
   - Specs print `rpc <n> <path>` for each page load, so you can see how close a screen is to
     its budget.

3. **Pick the specs**: the changed screen's own spec, plus any spec that walks it
   (`grep -l '<route or test id>' web/e2e/*.e2e.ts`).

## A skip is not a pass

Sixteen specs need Postgres (`grep -l DATABASE_URL web/e2e/*.e2e.ts`). Without
`DATABASE_URL` they skip: the run shows `﹣ row access e2e … # DATABASE_URL is unset` and
`ℹ skipped 1`, or the spec prints `skip password e2e: …` and exits 0.

**Check CI's count too, not just its colour.** In the `web` job's e2e log, `skipped` should be
`1`: `compose`, which runs against the stack in the `docker` and `helm` jobs. Anything more means
Postgres specs skipped there as well (before CI's `web` job had a Postgres service, a green run
read `skipped 12`). If your change touches their screens, run them locally against a throwaway
Postgres (Homebrew `postgresql@17`; start and stop it with the sandbox off, using an absolute
scratch directory):

```bash
initdb -D <scratch>/pg -U postgres -A trust
LC_ALL=en_US.UTF-8 pg_ctl -D <scratch>/pg -l <scratch>/pg.log -o "-p 54329 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start
E2E_NO_BUILD=1 DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres node --test --test-reporter=spec web/e2e/row-access.e2e.ts
pg_ctl -D <scratch>/pg stop -m fast
```

Each spec creates and drops its own scratch database. Report every spec you ran as **passed**,
**failed** or **skipped**, never a skip as a pass.

## Prove it tested your change

- The summary says `ℹ skipped 0`.
- The build is current: `grep -rl '<a string you just added>' web/dist/assets` finds it.
- Break the change once (revert one line) and rerun. If the spec still passes, it doesn't check
  your change, so add the assertion that would.

## Read a failure

After the assertion error, `e2e()` prints two blocks. Read them before the stack trace:

- `--- page problems ---`: console errors, page errors, CSP violations and RPC budgets. Often
  the cause of the failure, not a side effect of it.
- `--- server log (tail) ---`: the server's last 4 KB of log. Look for an error line
  (`"level":50`).

| Failure | Usually means | Fix |
|---|---|---|
| `RPC budget: 31 RPCs on …/dashboards (budget 25)` | the screen calls the API once per tile or row, or repeats a call the shell already made. The count covers everything from one navigation to the next, dialogs included | compare the spec's `rpc` lines with an `origin/develop` worktree, then drop the duplicate or batch the calls into one channel (`.claude/rules/web.md`: batch an endpoint before raising a budget). A per-test `{ rpcBudget }` only for calls that can't be avoided, with the reason beside it; never the default of 25 |
| `console error: …` or `page error: …` | the app logged or threw an error | fix the app. Failing on it is the fixture's job |
| `CSP violation: style-src-elem blocked inline …` | an inline style or script (the policy is `'self'` only) | move it into a CSS module or a file |
| `locator.waitFor: Timeout …` | the element never appeared: renamed, a state the spec didn't wait for, or the app failed first | read the page problems; screenshot just before the line |
| `… is missing: run npm run build:ts && npm --prefix web run build` | nothing built | build |
| `server did not listen within 30 s` or `server exited (…) before listening` | a broken or stale build, or an env var the spec set | the server output is inside the error |
| `seeding the sample project failed` | `build:ts` stale or broken | rebuild |

To see the page at a failing step, add
`await page.screenshot({ path: '<scratch>/step.png', fullPage: true })` before it, run, look,
and remove it. Screens from `screens()` are in `web/e2e/__screens__/<name>-light.png` and
`-dark.png` (gitignored). Look at them. CI uploads them as the `e2e-screens-chromium` artifact.

## A flaky spec

1. **Read the history before changing anything.**
   `gh run list -R AshishB2000/ordinate --workflow ci.yml --branch develop --limit 20`, then
   `gh run view <id> --log-failed` for each failure. A failed nightly (`e2e-nightly.yml`) keeps
   one open issue. Group the failures by where they happen (which locator, which request): two
   failures of one test can be two different races.
2. **Reproduce it alone.** Run only that spec, with nothing heavy beside it: a build, Vitest or
   the server suites running at the same time make content assertions flake on a laptop. Loop it:

   ```bash
   for i in $(seq 10); do E2E_NO_BUILD=1 node --test web/e2e/home.e2e.ts >/dev/null 2>&1 || { echo "failed on run $i"; break; }; done
   ```

   For a nightly failure, set `E2E_BROWSER` to its engine.
3. **Fix the narrowest cause the evidence shows.** Wait for the state the assertion needs
   (`settled(page)`, `locator.waitFor()`, the response), never for time: no `waitForTimeout`.
   Keep the user steps the test exists to cover: don't move them into API setup, loosen the
   assertion, or raise the RPC budget to get a pass. If the app shows a value before its data
   arrives, fix the app.
4. **Say what the evidence is.** Call it fixed when you can explain the failure from the logs,
   a forced repro fails before the fix and passes after, and the spec then passes about 30
   loops in a row. At a 10% flake rate, 3 passes in a row happens by luck 73% of the time and
   30 passes about 4% of the time. Report the loop count, and watch the next CI runs.
