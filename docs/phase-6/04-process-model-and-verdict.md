# Phase 6 · 04 — Process model, security, and the verdict

**Scope of this document:** the Electron→Tauri **process model**, the **IPC surface**, the
**security boundary**, config/secrets migration, Local CLI execution, the real size/memory delta,
and a recommendation on whether Phase 6 should happen at all.

**Verdict up front: close Phase 6.** Not defer — close. §7 gives the numbers.

---

## 0. Epistemic status — read this first

**Rust is not installed on this machine and was not installed. Nothing here was compiled or run.**
No Tauri scaffold exists, no `cargo build` was attempted, no port was prototyped. Every claim below
carries one of three labels:

| Label | Means |
|---|---|
| **MEASURED** | Read off files in this checkout or off the real built artifacts in `/Users/ashishb/Projects/ordinate/dist/`. Bytes on disk, not behaviour. |
| **RESEARCHED** | Taken from upstream documentation or a cited source, current as of this writing. Sources listed in §8. |
| **REASONED** | Inference from the two above. Could be wrong. Where an estimate has a range, the range is the honest uncertainty, not a hedge. |

Nothing in this document is **verified**. A verified claim would require a working port, and the
whole argument of §7 is that building one to find out is the expensive way to learn something the
cheap evidence already settles.

**Prior art this builds on, and does not redo:**
[`docs/phase-5/03-state-ipc.md`](../phase-5/03-state-ipc.md) already maps the bridge exhaustively —
118 keys on `window.hub`, 99 `invoke`, 7 `send`, 9 `on` pushes, 3 load-time `sendSync`, 112
`ipcMain` registrations, channel sets exactly closed. Those counts are taken as given. This
document asks a different question about the same surface: *what does each of those constructs
become on the other side, and what is lost in the translation?*

---

## 0.1 A correction to `CLAUDE.md`

`CLAUDE.md` states, twice, that deck.gl, the Svelte renderer **and the Tauri shell** were "argued
against on measured grounds in [`docs/phase-3/README.md`](../phase-3/README.md)".

**MEASURED:** they were not. `grep -i tauri docs/phase-3/README.md` returns nothing; so does
`grep -i svelte`. Phase 3 argues against **deck.gl only** (§3 of that document, 45 MB / 32 packages,
`@loaders.gl` fetching workers from unpkg.com). The word "Tauri" appears in exactly four places in
the whole repo outside `node_modules`: `README.md:279`, `AGENTS.md:21`, `CLAUDE.md` ×2, and the
original brief `.claude/plans/rewrite-to-duckdb-stack.md`.

This matters for the framing of this phase. **Tauri has never actually been argued against.** It
was *scheduled* (brief §5, "Phase 6 — Tauri shell. Last, and hardest") and three landmines were
flagged for it in advance (brief §6.3 no `desktopCapturer`, §6.4 Node-only export stack, §6.5 `pg`
and `exceljs` disappear) — but no one has ever costed it. This document is the first attempt, and
it should be read as the first-pass argument, not a confirmation of a settled one. If it says
"close it", that is a new conclusion, not an echo.

Fix `CLAUDE.md` to say that deck.gl was argued against in phase-3, and that Svelte (phase 5) and
Tauri (this document) were each costed in their own phase.

---

## 1. The process-model mapping

### 1.1 The shapes, side by side

| Electron today | Tauri v2 equivalent | Faithful? |
|---|---|---|
| `ipcMain.handle(ch, fn)` + `ipcRenderer.invoke(ch, arg)` | `#[tauri::command] async fn`, registered in `tauri::generate_handler![…]`; frontend calls `invoke('cmd', {args})` | **Yes.** Both are promise-returning request/response over a JSON-serialisable payload. 99 handlers map 1:1. |
| `ipcMain.on(ch, fn)` + `ipcRenderer.send(ch, arg)` | Also a `#[tauri::command]` returning `()`; the frontend ignores the promise | **Close.** Tauri has no true fire-and-forget renderer→core channel; the 7 `send` calls become commands whose result is discarded. Harmless, marginally slower. |
| `webContents.send(ch, payload)` (main→one window) | `WebviewWindow::emit(event, payload)` or `app.emit_to(label, …)` | **Yes, with a footgun** — see §1.3. |
| `ipcRenderer.sendSync(ch)` at preload load time | **Nothing.** Tauri v2 IPC is async-only (RESEARCHED) | **No.** See §1.4 — this is the one construct with no equivalent. |
| `contextBridge.exposeInMainWorld('hub', {…})` in a preload running in an **isolated world** | `WebviewWindowBuilder::initialization_script(…)`, running **in the page's own world** | **No.** See §1.2 — this is the load-bearing difference. |
| `contextIsolation: true`, `nodeIntegration: false` | Structurally implied: there is no Node in the webview to integrate. But there is also no second world. | **Different, not equivalent.** §2.1. |
| Five `BrowserWindow` factories (`src/windows/*.ts`) | Five `WebviewWindow`s, or `tauri.conf.json` `app.windows[]` | Yes. |
| `app.whenReady()`, `app.on('activate'/'second-instance'/'will-quit')` | `tauri::Builder::setup()`, `RunEvent::Reopen`, `tauri-plugin-single-instance`, `RunEvent::Exit` | Yes. |
| `globalShortcut.register` | `tauri-plugin-global-shortcut` (official) | Yes, with a new macOS Accessibility-permission prompt to handle (RESEARCHED). |
| `desktopCapturer` + `nativeImage` crop | Nothing built in. `xcap` crate, or `tauri-plugin-screenshots` which wraps it | **No.** §6.1. |
| `webContents.capturePage(rect)` | Nothing (RESEARCHED — no capture/print/PDF method on `Webview`/`WebviewWindow`) | **No.** §6.2. |
| `webContents.printToPDF()` | Nothing | **No.** §6.2. |
| `dialog.showSaveDialog` / `showMessageBox` | `tauri-plugin-dialog` | Yes. |
| `clipboard.writeText/writeImage` | `tauri-plugin-clipboard-manager` | Text yes; **image support is the weaker half** — REASONED, needs checking against the two `hub:copy` call sites. |
| `shell.openExternal(url)` | `tauri-plugin-opener` | Yes. The `x-apple.systempreferences:` deep links in `src/ipc/shell.ts` need the opener scope to permit a non-http scheme. |
| `Notification` | `tauri-plugin-notification` | Yes. |
| `nativeTheme` + `theme:apply` push | `Window::theme()` + `on_theme_changed` | Yes. |
| `net.fetch` in main (BYOK provider calls) | `reqwest`, or `tauri-plugin-http` | Yes — but every provider adapter in `analyze.ts` / `models.ts` is rewritten in Rust. |
| Worker thread + `SharedArrayBuffer` + `Atomics.wait` (`src/duckdb.ts`) | **Deleted.** `duckdb` crate called directly from a Rust command | **Strictly better.** §5.3. |

### 1.2 What the preload layer *becomes* — and this is the crux

Today `preload/hubPreload.ts` is 373 lines and it is **the only thing between the renderer and
main**. Its properties, in order of importance:

1. It runs in an **isolated JavaScript world**. The 22 hub scripts, Chart.js, MapLibre, pdfmake,
   docx, pptxgenjs and the vgplot vendor bundle all share the *main* world and cannot see
   `ipcRenderer`. They see exactly one object, `window.hub`, whose 118 keys are hand-written.
2. It is **an enumerable allowlist**. Every capability the renderer has is one line in one file
   that a human wrote. A channel not listed is not reachable — not "not permitted", *not
   reachable*, because `ipcRenderer` does not exist in that world.
3. It **shapes the payload**. Each method wraps positional arguments into a single object per
   channel. The renderer cannot choose the wire shape.
4. It is **per-window**. The overlay preload is 11 lines, the status preload 10. Phase 5's §1.5
   calls this out explicitly: "each is a deliberate least-privilege surface."

Under Tauri, **none of that survives as a mechanism.** There is no preload and no second world. The
frontend gets `window.__TAURI_INTERNALS__.invoke` injected by Tauri's own initialisation scripts,
which run before any page script (RESEARCHED). `invoke(name, args)` takes the command name as a
**string parameter**. Any script that runs in the page — including MapLibre, including a
compromised transitive dependency of pdfmake, including the vgplot bundle — can call **any**
registered command, with **any** payload shape.

So the honest translation is:

> The preload does not become a Tauri construct. It becomes a **convention**: a hand-written
> `bridge.ts` in the frontend that wraps `invoke()` in 118 typed functions. That file is
> documentation and ergonomics. It is not a boundary. Deleting it would not remove a single
> capability from a page script.

The boundary moves from *"which functions exist in this world"* (structural, enforced by V8) to
*"which command names the core will dispatch"* (a string match in generated Rust). Both are real
enforcement. But the Electron one also constrains **who inside the page** can reach it, and the
Tauri one does not.

Tauri's own answer is the **Isolation pattern**: a sandboxed iframe that all IPC is routed through
and AES-GCM-encrypted by. It is not equivalent either:

- **RESEARCHED:** on Windows, external files do not load inside the sandboxed iframe, so the
  isolation app's scripts must be inlined at build time — which for this repo means an inline
  `<script>` in the isolation frame, the exact thing
  [phase 3c](../phase-3c/README.md) patched a third-party library's source to avoid.
- **RESEARCHED:** Tauri's own security advisory GHSA-57fm-592m-34r7 documents that *any* iframe
  added to a Tauri frontend gets access to Tauri APIs, **even in isolation mode**, and that
  remote-origin iframes could reach the IPC endpoint bypassing the origin check.
- **RESEARCHED:** the Radically Open Security audit of Tauri 2.0 (August 2024) records that on
  Windows and Android the isolation frame's internals can be reached from the hosting application,
  defeating the key protection.

None of those are disqualifying for a typical Tauri app. They are disqualifying for a *migration
justified as a security improvement*, which this one would have to be, because §5 shows it cannot
be justified on size.

### 1.3 The 9 pushes become events, and events broadcast by default

`webContents.send` targets one `webContents`. Every one of main's 9 pushes is aimed at
`hubWindow` specifically, and several are guarded (`if (!hubWindow || hubWindow.isDestroyed())`).

**RESEARCHED:** `app.emit()` in Tauri delivers to **all** listeners in all webviews. Targeting one
window requires `emit_to(label, …)` or `emit_filter`. And any script in any webview can `listen()`
for any event name.

Three of the nine carry things that should not be broadcast:

| Push | Payload | Why broadcast is wrong |
|---|---|---|
| `hub:entry-result` | the full `AnalyzeResult` — model prose, `extractedTable`, metrics | It is the analysed *contents of the user's screen*. The overlay window is a full-screen always-on-top surface; there is no reason for it to receive this. |
| `hub:new-entry` | `{ entryId, dataUrl }` — the **base64 crop of the user's screen** | Same. |
| `hub:history` | every capture's title + `cropPath` | Same. |

This is not a theoretical objection — it is a straightforward porting mistake that `app.emit()`
makes the *default* and `webContents.send` makes *impossible*. **Every one of the 9 pushes must be
`emit_to(hub_label, …)`, and that has to be a review rule with a test, because the wrong call
compiles, runs, and looks identical.**

REASONED: this is the single most likely security regression in an actual port. It is cheap to
avoid and cheap to get wrong.

### 1.4 The three `sendSync` reads have no equivalent

`preload/hubPreload.ts:11,14,17` fill `providerLogos`, `agentLogos` and `appVersion` with
`ipcRenderer.sendSync` **at preload evaluation time**, so they are plain data properties by the time
any hub script runs. Phase 5 §1.4 correctly says these "must never become stores".

**RESEARCHED:** Tauri v2 IPC is async-only; there is no `sendSync`. `invoke()` posts to the
`ipc://localhost` custom protocol and returns a Promise.

Two honest options:

- **`initialization_script`** — serialise the three values into a `window.__ordinate_boot = {…}`
  literal and inject it before page scripts. This is the faithful port and it works. Caveat
  (RESEARCHED): `Plugin::Builder::js_init_script` only accepts static values, so for anything read
  from Rust state the window has to be built manually in `setup()`. All three of these values *are*
  effectively static (`app.getVersion()` and two constant icon maps), so this is fine here.
- Make them async and gate first paint on them. Worse — it turns a zero-cost property read into a
  render-order dependency in the one place the app currently has none.

Take `initialization_script`. Note it puts the icon-path map into the page as a literal, which is
what the preload effectively does today anyway.

### 1.5 Command granularity — do not translate 1:1 blindly

99 `#[tauri::command]`s is a lot of Rust, but the count is not the problem. Three specific channels
need design attention rather than translation:

- **`dataset:page`** returns one ~500-row window and is the hot path for the Explore grid. As a
  command it is fine; the JSON round-trip is the same as today's structured clone, probably
  cheaper.
- **`mosaic:query`** is explicitly *async-bridge only* and is issued per animation frame during a
  brush drag. In Rust it is naturally async — this is the one place Tauri is structurally better
  than the current `Atomics.wait` design (§5.3). Consider a **Channel** rather than a command
  (RESEARCHED: Channels are Tauri's ordered, high-throughput streaming primitive).
- **`hub:capture`** is the one channel Phase 5 §7.5 flags as unmodellable: a request whose response
  is a push, correlated by an id the caller never sees. Under Tauri it should just become an
  `async` command returning `{ started, entryId? }`. Phase 5 explicitly declines to smuggle that
  main-process change into a renderer port; a shell port is where it belongs. **This is one of
  exactly two things Phase 6 would genuinely improve** (the other is §5.3).

---

## 2. Security, held to the current standard

The rule for this section: the current app is the bar. A port that is "normal for Tauri" but weaker
than what ships today is a regression, and saying "Tauri is memory-safe" does not pay for it.

### 2.1 The invariants, one by one

| # | Invariant today | Under Tauri | Net |
|---|---|---|---|
| 1 | **`contextIsolation: true`** — preload in an isolated world, renderer sees only `window.hub` | No second world exists. `__TAURI_INTERNALS__.invoke` is reachable from every script in the page (RESEARCHED). Isolation pattern is an iframe with documented bypasses (§1.2) | **WEAKER** |
| 2 | **`nodeIntegration: false`** — no `fs`, `child_process`, `require` in the renderer | Structurally guaranteed: there is no Node in a WKWebView | **STRONGER** (belt becomes structure) |
| 3 | **CSP `default-src 'none'`, no `unsafe-inline`, no `blob:`** | Tauri requires `connect-src ipc: http://ipc.localhost` for IPC to function (RESEARCHED). Tauri injects its **own nonces and hashes** into `script-src`/`style-src` for bundled assets | **WEAKER**, and see §2.2 |
| 4 | **Secrets never leave main** — `publicConfig()`/`publicByok()` are the only renderer-safe views; `byok:revealKey` is the one deliberate exception | Unchanged in principle — the same two functions, in Rust. But every command is callable by any page script (inv. 1), so `revealKey` goes from "reachable only via the one preload method the settings panel calls" to "reachable by anything running in the page" | **WEAKER by inheritance** from inv. 1 |
| 5 | **UUID-validated paths** (`UUID_RE`, dual-UUID guard on `projectId` + record id) before any id touches a path | Port the same regex. Rust adds nothing here — the guard is a string check, not a memory-safety property. `PathBuf::join` with an attacker-controlled `../` is exactly as traversable in Rust as in Node | **NEUTRAL** |
| 6 | **Atomic writes** (temp sibling → `rename`) in `src/config.ts:276` and every store | `std::fs::rename` is the same syscall. Rust makes it slightly harder to forget the `fsync`-adjacent details, and slightly easier to get `rename` across filesystems wrong | **NEUTRAL** |
| 7 | **Shell-free `execFile`, args array, never `shell: true`** | §4. The shell plugin's scope model cannot express what this app needs, so a real port bypasses the plugin and calls `std::process::Command` directly | **NEUTRAL at best** — §4 |
| 8 | **Corrupt config preserved, not overwritten** (`config.json.corrupt`) | Straight port | **NEUTRAL** |
| 9 | **No telemetry, no surprise network calls; OSM tiles are the one declared fetch** | Same, *if* DuckDB extensions are statically linked rather than downloaded from `extensions.duckdb.org` at first use. That is a new failure mode Tauri introduces via §5.4 | **AT RISK** |
| 10 | **Memory safety of the main process** | Rust vs Node. Genuine, but the main process today is TypeScript calling a prebuilt DuckDB N-API module and `pg`; the memory-unsafe surface is already in C++ and stays there | **STRONGER, marginally** |

**Score: two invariants strengthened (one of them marginally), four weakened, four neutral.**

### 2.2 The CSP, specifically

Today's hub CSP (MEASURED, `renderer/hub/index.html:14`):

```
default-src 'none'; style-src 'self'; script-src 'self';
connect-src https://{a,b,c}.tile.openstreetmap.org;
img-src data: file: https://{a,b,c}.tile.openstreetmap.org;
```

That is a genuinely tight policy, and this repo has paid real costs to keep it byte-exact:
`scripts/build-vendor.js` patches Observable Plot's three `<style>` injections out of the vgplot
bundle and **exits non-zero if the patch stops applying**; phase 3c banned `vg.table()` outright
because its per-instance dynamic CSS cannot be pre-extracted; phase 5 rejected Vite because the dev
server would need `script-src http://localhost:5173` and `connect-src ws://localhost:5173`.

Under Tauri the same page needs, at minimum, `connect-src ipc: http://ipc.localhost` added
(RESEARCHED). That is a small, well-understood addition and I would not close a phase over it.

The part I would push back on is the **nonce/hash injection**. Tauri "will append its nonces and
hashes to the relevant CSP attributes automatically to bundled code and assets" (RESEARCHED). That
is a good default for most apps and a bad fit for this one, because this repo's CSP discipline is
built on the property that **the shipped policy is a literal string a human can read in
`index.html` and diff against `devops`**. Phase 5's toolchain doc treats "two CSPs that can drift"
as the failure mode to design against. A framework-generated policy with framework-generated
nonces is a third CSP that no one diffs.

There is a config switch, `dangerousDisableAssetCspModification`, whose own documentation warns
"Your application might be vulnerable to XSS attacks without this Tauri protection". Using it to
recover the current property means opting out of the framework's protection to keep a stricter
hand-written one — defensible, but it should be a deliberate, documented decision, not a
discovery.

### 2.3 The capability model: genuinely different, and — here — mostly beside the point

This is the part of Tauri most often cited as "safer than Electron", so it deserves a straight
answer rather than a nod.

**What it actually is (RESEARCHED):** `src-tauri/capabilities/*.json` files map **windows/webviews →
permissions**. Permissions are declared by plugins (and, optionally, by your app). Nothing dangerous
is enabled by default — the shell plugin, for instance, exposes only `allow-open` for safe URI
schemes until you say otherwise. Scopes can further constrain a permission (allowed paths, allowed
commands, allowed URLs). It is a static, reviewable, per-window allowlist checked in to the repo.

**That is a real and good design.** It is meaningfully better than Electron's *default*, where a
`BrowserWindow` with `nodeIntegration: true` hands the renderer the entire Node API.

**But this app is not at Electron's default.** The relevant comparison is not
"capabilities vs. nothing", it is "capabilities vs. a 373-line hand-written preload allowlist that
is already per-window and already checked in". On that comparison:

- **Coverage.** Capabilities gate *plugin* permissions. **RESEARCHED:** "By default, all commands
  that you registered in your app (using `tauri::Builder::invoke_handler`) are allowed to be used by
  all the windows and webviews of the app." Constraining custom commands per-window requires
  opting in via `AppManifest::commands` in `build.rs`. So the 99 commands that *are* this app —
  every dataset, dashboard, secret and CLI operation — are **outside the capability system unless
  you do extra work**, while the preload gates them today by construction.
- **Granularity.** The preload's granularity is per-method-per-window and is the default. The
  capability system's granularity for app commands is per-window-per-command and is opt-in.
- **What it adds that the preload does not:** scopes. `fs:allow-read` restricted to a path glob,
  `http:default` restricted to an origin list — declarative constraints on *arguments*, which the
  preload has no vocabulary for. That is a genuine capability the current design lacks. Ordinate
  hand-rolls the equivalent in main (`UUID_RE` guards, `https`-only URL fetch, byte/timeout caps,
  the `GEO_FILES` whitelist) and does it well. Declarative would be nicer. It would not be *safer*
  than what is already written.

**Assessment: genuinely different, better than default Electron, roughly a wash against this
app's actual design, and it does not offset §2.1's inv. 1.** A capability file that says "the hub
window may call `dataset:page`" is worth less than a world boundary that means MapLibre cannot call
anything, because the realistic threat here is not "the hub window is malicious" — it is "one of
the 12 third-party browser bundles loaded into the hub is compromised". Electron's preload answers
that threat. Tauri's capability model, by design, does not: it authorises *windows*, and the
compromised dependency is running inside the authorised window.

### 2.4 What Tauri would genuinely strengthen

Not nothing, and it should be said plainly:

- **No Node in the renderer, structurally.** Inv. 2 stops being a setting.
- **A memory-safe main process** for the parts that are today TypeScript. Marginal, since the
  parsing that most wants memory safety (Parquet, CSV, XLSX, Postgres wire) is already delegated to
  DuckDB/`pg`.
- **`tauri-plugin-single-instance`** is a cleaner mechanism than `app.requestSingleInstanceLock()` +
  `process.exit(0)` (`main.ts:16–21`).
- **Deleting the `SharedArrayBuffer` bridge** (§5.3). This is the big one, and it does not require
  Tauri.

---

## 3. Config and secrets — the migration hazard, quantified

### 3.1 Where the data lives today

**MEASURED.** `src/config.ts:161` — `path.join(app.getPath('userData'), 'config.json')`. Electron
derives `userData` from `productName`, and `package.json` still carries `productName: "Screenchart"`.
So on macOS:

```
~/Library/Application Support/Screenchart/
  config.json          ← plaintext BYOK API keys + per-connection pg passwords / URL tokens
  projects/<uuid>/     ← project.json, datasets/*.json, *.parquet, *.source.parquet,
                         visuals/, dashboards/, copilot.json
  history/             ← thread.json + crop.png per capture
  tmp/                 ← crops handed to Local CLIs
```

`CLAUDE.md` already flags renaming `productName` as "a migration, not a find-and-replace" because it
moves `userData` and orphans everything above.

### 3.2 Where it would live under Tauri

**RESEARCHED.** Tauri's `PathResolver::app_data_dir()` resolves to
`$HOME/Library/Application Support/${bundle_identifier}` on macOS and
`{FOLDERID_RoamingAppData}/${bundle_identifier}` on Windows. The identifier is
`tauri.conf.json`'s `identifier`, described as "unique across applications since it is used in
system configurations like the bundle ID and path to the webview data directory."

**MEASURED:** this app's `appId` is `app.screenshot.desktop` (`package.json:59`, and
`app.setAppUserModelId('app.screenshot.desktop')` at `main.ts:46`).

So the default Tauri path is:

```
~/Library/Application Support/app.screenshot.desktop/
```

**A different directory from `Screenchart/`.** Every existing install's config, keys, connection
secrets, projects, Parquet files and capture history would be invisible to the ported app, which
would boot to a clean first-run state — with the user's API keys still sitting in plaintext in the
old directory that the new app no longer knows about.

**CLAUDE.md is right that a shell change makes the `productName` hazard worse, and here is exactly
why:** the `productName` rename is a hazard the team controls and can decline. The Tauri path change
is *not optional* — the identifier-derived path is how Tauri resolves app data. You cannot ship the
port without either moving the data or overriding the path.

### 3.3 The migration, specified

It is writable. It is also load-bearing in a way the rest of the port is not, because getting it
wrong loses a user's projects.

**Option A — pin the path (recommended).** Do not use `app_data_dir()`. Resolve
`dirs::data_dir().join("Screenchart")` explicitly and keep every path identical. Zero migration,
zero risk, one comment explaining why the app's data directory does not match its identifier.
Cost: a permanent, slightly surprising deviation from Tauri convention, and Windows needs the same
treatment (Electron's `userData` on Windows is `%APPDATA%/Screenchart`; Tauri's default would be
`%APPDATA%/app.screenshot.desktop`).

**Option B — copy-on-first-run.** On startup, if the new directory is absent and the old one
exists, copy the tree, verify, and leave the original in place (never move, never delete). This is
the honest one if the goal is to also land the `productName` cleanup. Requirements, all of which
must be explicit:

1. **Copy, do not move.** A half-completed move on a full disk destroys the only copy of a user's
   projects.
2. **Verify before declaring success.** Compare file counts and byte sizes for `config.json` and
   every `*.parquet`; a truncated Parquet is not detectable by opening it lazily later.
3. **`config.json` is copied first and atomically** (temp sibling → `rename`), because it holds
   every plaintext key. The existing `persist()` already does this and the `.corrupt` preservation
   path at `config.ts:291` must be preserved too.
4. **Leave the old directory.** Deleting it is a data-loss bug waiting for the one user whose copy
   silently failed. Offer "Reveal old data folder" in Settings and let them delete it.
5. **The `.parquet` files are the irreplaceable part.** `project.json` and dataset metadata can be
   regenerated from a re-import; a 500k-row Parquet whose source CSV the user deleted cannot.
6. **File permissions.** `config.json` holds plaintext secrets. Whatever mode it has today must be
   reproduced, not left to the default `umask` of the copying process.

**Option C — no migration.** Ship it, tell users to re-add their keys and re-import their data.
For a local-first BI tool whose entire value proposition is the projects on the user's disk, this
is not a real option. Naming it only so it is on the record as rejected.

### 3.4 Secrets: what does *not* change

Worth stating so no one claims Tauri fixes it. Keys are plaintext in `config.json` today. Under
Tauri they would be plaintext in `config.json` under a different path. Rust does not encrypt
anything for you.

Tauri does have `tauri-plugin-stronghold` (an encrypted vault), and macOS has the Keychain. Both are
available to the **current Electron app** too — `safeStorage` has shipped in Electron for years and
is not used here. **Encrypting the keys is an independent decision that has nothing to do with the
shell, and bundling it into a Tauri argument would be borrowing credit.**

---

## 4. Local CLI execution under Tauri's shell plugin

### 4.1 What has to keep working

**MEASURED**, from `src/localCli.ts` and `src/localCliRun.ts`:

- Six runnable CLIs: `claude`, `antigravity` (`agy`), `codex`, `grok`, `opencode`, `cursor`
  (`cursor-agent`).
- **Detection** resolves a bare binary name against `PATH` plus known bin dirs *without spawning
  anything* (`localCli.ts:199`), then runs `<resolvedPath> --version` via `execFile` with a fixed
  `versionArgs` array, `detached: true` so the whole process group can be reaped.
- **Execution** is `spawn(cmd, argsArray, { cwd, windowsHide, detached, env })` — never
  `shell: true`. The prompt is passed as an argv element or on stdin, never interpolated into a
  command string.
- The resolved path is **internal-only**: `publicLocalCli()` (`config.ts:597`) deliberately omits
  `resolvedPath` from the renderer-safe view.
- On packaged macOS, every spawn is prefixed by `Contents/Resources/disclaim-exec`
  (`src/disclaim.ts`, built from `native/disclaim-exec.c`) so the agent becomes its own TCC
  responsible process. **MEASURED:** the compiled helper is 100 KB in the shipped bundle.
- The app **detects and runs only**. The "Install" button opens a vendor URL.

The critical property: **the binary path is discovered at runtime**. It is `/opt/homebrew/bin/claude`
on one machine, `~/.local/bin/claude` on another, `~/.bun/bin/opencode` on a third — and
`main.ts:87` recovers the user's real login-shell `PATH` precisely because a packaged GUI launch
inherits a stripped one.

### 4.2 Does the shell plugin permit that? No.

**RESEARCHED.** A `shell:allow-execute` scope entry is:

```json
{ "name": "exec-sh", "cmd": "sh", "args": ["-c", { "validator": "\\S+" }], "sidecar": false }
```

`cmd` is a **fixed literal string in the capability file, resolved at configuration time, not at
runtime.** `args` can mix literals with `{"validator": "<regex>"}` entries, so *arguments* can be
dynamic within a pattern. There is no equivalent for `cmd` — no glob, no validator, no "any
absolute path". `sidecar: true` covers binaries you ship, which is explicitly not this case: the
app must never install a CLI.

So the scope model can express *"run `sh` with args matching `\S+`"*. It cannot express *"run
whichever absolute path `which claude` returned on this user's machine"*.

Three ways out, and only one is acceptable:

| Approach | Verdict |
|---|---|
| Enumerate every plausible install path as a separate scope entry (`/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.local/bin/claude`, … × 6 CLIs) | Unshippable. Combinatorial, incomplete by construction, and breaks the moment a user uses a version manager. |
| Scope `sh -c` with a permissive arg validator and build a command string | **Actively worse than today.** It reintroduces a shell, which `CLAUDE.md` bans in as many words: "Local CLI execution is shell-free: `execFile`/`spawn` with an **args array, never `shell:true`**". A user-supplied model name or prompt reaching a `sh -c` string is a command-injection bug the current design makes structurally impossible. **If a port takes this shortcut, it is a hard security regression.** |
| **Do not use the shell plugin.** Write `#[tauri::command]` wrappers over `std::process::Command`, keeping the args-array discipline, the detached process group, the timeouts and the `disclaim-exec` prefix | **The only correct answer.** |

### 4.3 What that means for the security story

The third option works and is a faithful port. But notice what it costs rhetorically: **the part of
the app with the most dangerous capability — spawning arbitrary user binaries with user- and
model-influenced arguments — is exactly the part that has to opt out of Tauri's capability system
entirely.**

A custom `run_local_cli` command is, by default, callable from any window and any script in it
(RESEARCHED, §2.3), unless `AppManifest::commands` is wired up in `build.rs`. Today the equivalent
is unreachable from the renderer at all — there is no `window.hub` method that runs a CLI with
caller-chosen arguments; the renderer can only say `cli:test { id }` where `id` is validated against
a fixed registry.

So on the single highest-risk surface in the app, Tauri's much-advertised safety model contributes
nothing, and the preload it replaces was doing real work.

Two more items, smaller but real:

- **`disclaim-exec`** (`native/disclaim-exec.c`, built by `scripts/afterPack.js` into
  `Contents/Resources/`) uses `POSIX_SPAWN_SETEXEC`. It is plain C and platform-specific, not
  Electron-specific — it ports unchanged. But the *build hook* does not: `afterPack`/`afterSign`
  are electron-builder concepts and become a `tauri.conf.json` bundle hook or a `build.rs` step.
- **`resolveUserPath()`** (`main.ts:87`) recovers the login-shell `PATH` on packaged launch. A GUI
  Tauri app inherits the same stripped `PATH` from `launchd`. Same problem, same fix, must be
  reimplemented in Rust and must run before the first detection — `main.ts` is careful about this
  ordering and a port that isn't will ship the "New capture does nothing" bug the comment at
  `main.ts:359` describes fixing.

---

## 5. The actual benefit, quantified

### 5.1 What is actually shipped today — measured, not estimated

**MEASURED**, from the real built artifacts in `/Users/ashishb/Projects/ordinate/dist/`:

| Artifact | Bytes | |
|---|---:|---|
| `Screenchart-0.1.0-arm64.dmg` | 210,216,393 | **200.5 MiB** download |
| `Screenchart-0.1.0-universal.dmg` | 274,346,389 | **261.6 MiB** download |
| `Screenchart.app` installed (arm64) | — | **561 MB** on disk |

Composition of the installed arm64 app:

| Component | Size | Share |
|---|---:|---:|
| `Contents/Frameworks/Electron Framework.framework` | **270 MB** | 48% |
| `app.asar.unpacked/…/libduckdb.dylib` (arm64) | **112 MiB** | 20% |
| `app.asar.unpacked/…/libduckdb.dylib` (**x64**) | **112 MiB** | 20% |
| `app.asar` (all app code + JS deps + assets) | **64 MB** | 11% |
| Helper apps, Squirrel, Mantle, ReactiveObjC, icon, `disclaim-exec` | ~3 MB | <1% |

**Read that table twice.** An **arm64-only** build is shipping the **x64** DuckDB dylib as well —
112 MiB of dead weight, 20% of the install. MEASURED: both are present in
`dist/mac-arm64/Screenchart.app/Contents/Resources/app.asar.unpacked/node_modules/@duckdb/`.
REASONED cause: `predist:mac` runs
`npm i --force --no-save @duckdb/node-bindings-darwin-x64` to prepare the *universal* target, and
`files: ["**/*"]` then sweeps it into whatever is built next. The universal DMG genuinely needs
both; the arm64 one does not. This is §7.2 item 1.

Inside the 64 MB asar, by package (MEASURED, top items):

| | MiB | |
|---|---:|---|
| `simple-icons` | 15.2 | brand glyphs; the app reads a handful of paths out of it in main |
| `pdfmake` + `pdfkit` + `fontkit` + `brotli` + `unicode-trie` | 19.2 | the PDF stack, of which `vfs_fonts.js` alone is 835 KiB |
| `exceljs` | 6.2 | XLSX read, one sheet, read-only |
| `docx` | 4.3 | |
| `assets` | 3.6 | of which `assets/geo/us-counties.json` is 1.9 MiB |
| `pptxgenjs` | 1.7 | |
| `leaflet` | 1.4 | Phase 4 replaced it with MapLibre — **already gone at HEAD** (see note) |
| `chart.js` | 1.4 | |
| `renderer` | 1.4 | the whole hub UI |
| `src` | 0.7 | the whole main process |

*Note on staleness:* this DMG was built 2026-08-01 from a commit predating the MapLibre swap —
`leaflet` is present and `maplibre-gl` absent. Current `package.json` has the reverse, and
**MEASURED: `leaflet` is absent from `node_modules` at HEAD**, so the swap was clean and there is no
stray dependency to remove. Rebuilt at HEAD the asar would lose 1.4 MiB of Leaflet and gain
~1.1 MiB of MapLibre
(`maplibre-gl-csp.js` 731 KB + `maplibre-gl-csp-worker.js` 352 KB + CSS 66 KB, MEASURED), plus the
594 KiB committed `vendor/vgplot.js`. Call it a wash. The Electron and DuckDB figures — the ones
that matter — are unaffected.

### 5.2 The delta, honestly

**What Tauri removes:** the 270 MB Electron Framework. That is the whole of the offer.

**What Tauri does not remove:**

- **DuckDB.** The `duckdb` Rust crate's `bundled` feature compiles libduckdb from source and links
  it statically (RESEARCHED). A stripped static link with dead-code elimination should beat a
  112 MiB unstripped dylib with a full export table, but not by an order of magnitude —
  **REASONED: 50–90 MiB per architecture.**
- **The webview JS payload.** `pdfmake`, `pdfkit`, `fontkit`, `docx`, `pptxgenjs`, `chart.js` and
  its five plugin bundles, `maplibre-gl`, the vgplot vendor bundle and the geo assets are all
  **loaded as `<script src>` in the renderer** (MEASURED, `renderer/hub/index.html:1462–1494`). They
  are browser JavaScript. They ship identically under any shell. That is ~40 MiB of the 64 MB asar
  that Tauri does not touch.
- **`assets/geo`.** 2.1 MiB of GeoJSON. Unchanged.

**What Tauri could plausibly remove from the asar:** `exceljs` (6.2 MiB) and `pg`, if replaced by
DuckDB's `excel` and `postgres` extensions per brief §6.5 — but see §5.4, which turns that saving
into a liability. `simple-icons` (15.2 MiB) is a main-process dependency and would need a Rust
equivalent — but see §5.5, because it should not be 15.2 MiB in the first place.

**The arithmetic (REASONED, arm64-only, ±30%):**

| | Installed | Download |
|---|---:|---:|
| Today, as shipped (arm64 DMG carries both DuckDB arches) | 561 MB | 200 MiB |
| Today, **fixing only the duplicate DuckDB arch** | ~449 MB | ~130–150 MiB |
| Today, fix arch **+ trim `simple-icons`** | ~434 MB | ~125–145 MiB |
| **Full Tauri port** | ~125–165 MB | ~60–85 MiB |

So: **Tauri is worth roughly 280–320 MB installed and 50–70 MiB of download, against a
correctly-packaged Electron build.** Not nothing. But note what the second row of that table says:
**the single largest size win available to this product costs one line of `electron-builder`
config, not a shell rewrite.**

### 5.3 The one architectural win, and it is free

`src/duckdb.ts` parks DuckDB in a worker thread and blocks the main thread on `Atomics.wait` over a
growable `SharedArrayBuffer`, because `@duckdb/node-api` is async-only and the callers are
synchronous. The file's own header is 80 lines of careful reasoning about why this does not
deadlock, plus a measured async transport comparison, plus a known BOM-loss bug in the binding.
`CLAUDE.md` records the consequence plainly: "a blocking call freezes all five windows, the menu bar
and the hotkey."

**All of that disappears in Rust.** `duckdb-rs` is a synchronous C API wrapper — `conn.query(...)`
just returns. No worker, no SharedArrayBuffer, no control block, no dual reply channel, no
sync/async mixing analysis, no `Atomics.wait` freezing the UI. And **RESEARCHED:** `duckdb-rs`
exposes Arrow natively (`query_arrow()` returning `RecordBatch`es), which retires
`CLAUDE.md`'s "Apache Arrow is **not** achievable with the current binding" — the constraint is a
property of `@duckdb/node-api`, not of DuckDB.

This is a real and attractive prize. It is also **the strongest argument in Tauri's favour, and it
does not require Tauri.** A Rust or N-API sidecar process speaking to Electron's main over stdio
would get the same deletion. So would `@duckdb/node-api` shipping a sync API. Attributing this win
to the shell port is the same category error as attributing key encryption to it (§3.4).

### 5.4 A risk Tauri introduces: DuckDB extensions

Brief §6.5 proposes replacing `pg` and `exceljs` with DuckDB's `postgres` and `excel` extensions.
That is a genuine simplification — and it has a sharp edge for *this* product.

DuckDB extensions are, by default, **downloaded on first use from `extensions.duckdb.org`**. For an
app whose README promises "no telemetry, no surprise network calls — OSM tiles are the one declared
external fetch", a silent HTTP fetch the first time someone opens a spreadsheet is a **direct
violation of invariant 9**. Avoiding it means statically linking the extensions into the binary,
which is possible and adds size back.

REASONED: this is worth flagging because it is exactly the kind of thing a port discovers in week
six, after the interesting work is done and the sunk cost is arguing for shipping it.

### 5.5 Memory, and why the benchmark numbers do not transfer

The commonly cited figures (RESEARCHED, from comparison articles rather than first-party
measurement, and I would not put weight on them) are ~40 MB idle for Tauri against ~170 MB for
Electron, and ~3–4× faster cold start.

Three reasons those numbers do not describe this app:

1. **Accounting.** On macOS, WKWebView renders in `com.apple.WebKit.WebContent`, a separate OS
   process. The memory is still allocated; it is attributed elsewhere. "The app uses 40 MB" and
   "the system allocated 40 MB" are different claims and idle-RSS benchmarks routinely conflate
   them. REASONED.
2. **Idle is not this app's regime.** Ordinate's working set is dominated by things that are
   identical under both shells: DuckDB's buffer pool over a 1M-row Parquet, MapLibre's GL buffers
   and raster tile cache, Chart.js canvases at retina scale, the 1.9 MiB `us-counties.json` parsed
   and cached in main, and a `dsPreview` that can hold a full `ParseResult` up to the row cap.
   Phase 5 §5.3 calls that last one out as a multi-hundred-MB retention bug nobody would catch. The
   shell's fixed overhead is a constant added to all of that, not a multiplier on it.
3. **A five-window Electron app that opens one window at a time.** Only the hub is normally open;
   the overlay exists during a capture and the offscreen report window for the duration of an
   export. Electron's per-renderer-process cost is real, but this app is not paying it five times
   over.

REASONED: a real saving exists — plausibly 100–200 MB of resident set at idle. For a BI tool
running one window on a developer's Mac, that is below the threshold at which anyone changes their
behaviour.

### 5.6 Is the saving worth anything to *this* product's users?

The audience, per `CLAUDE.md`, is "developers / local-AI users (fast, private, no-key)", macOS-first,
on a machine that already has Claude Code or Codex installed — i.e. someone who has already accepted
a multi-gigabyte toolchain. They download the app **once**.

Ranked by what a user of this product actually notices:

1. **Does capture work?** (Screen Recording permission, the `PATH` recovery, the readiness gate.)
2. **Is a 1M-row dataset fast?** — solved by Phases 1–3a, measured at 206–630×.
3. **Are my keys and data private?** — invariants 4 and 9.
4. **Does export produce a correct PDF/PPT/DOCX?**
5. *…several other things…*
6. **Is the download 200 MB or 80 MB?**

A one-time 120 MiB download saving, on a product with no auto-update pressure and no bandwidth
cost to the user, in exchange for rewriting the process model, the IPC surface, the capture loop,
the export stack and the test harness. **REASONED: no, it is not worth anything to this product's
users.**

---

## 6. Everything else that breaks (so the cost is not understated)

Not the focus of this document — the other Phase 6 agents own the detail — but the verdict is not
honest without the list.

### 6.1 The capture loop
`desktopCapturer` → frozen frame of the display under the cursor → full-screen dimming overlay →
drag-box → crop. Brief §6.3 flagged it and budgeted it as its own phase. **RESEARCHED:** the Rust
answer is `xcap` (or `tauri-plugin-screenshots`, which wraps it). Note the plugin's macOS path uses
the `screencapture` CLI for window capture specifically to avoid needing Screen Recording
permission — which is *not* what this app does; it captures a display, needs the permission, and
`main.ts:164–199` contains hard-won handling of Electron's advisory-and-often-wrong
`getMediaAccessStatus`, plus a workaround for the broken ScreenCaptureKit path
(`main.ts:34`, `electron#38190`). All of that is macOS behaviour, not Electron behaviour, and
reappears in Rust in a different shape.

### 6.2 Export — the offscreen render, not the libraries

Brief §6.4 says "the export stack is Node-only. `pdfmake`, `docx`, `pptxgenjs` … Tauri has no Node."

**MEASURED: that is wrong, and the correction matters.** All three run **in the renderer** as
browser UMD bundles (`renderer/hub/index.html:1484–1491`); the renderer builds the file and hands
main base64 purely for the save dialog (`src/ipc/fileSave.ts`). They port unchanged.

What does *not* port (RESEARCHED — no capture or print API on Tauri's `Webview`/`WebviewWindow`):

- **`src/reportCapture.ts`** — a hidden `BrowserWindow` with `paintWhenInitiallyHidden`, sized to
  full content height, then `capturePage()` at the display scale factor, or `printToPDF()`. This is
  `hub:captureReport`, `dashboard:exportPng` and `dashboard:exportPdf`. There is no Tauri
  equivalent, and the file's own header documents why the obvious substitutes were rejected.
- **`hub:captureRegion`** — `capturePage(rect)` on the *visible* hub, which composites MapLibre's
  WebGL canvas **and** the DOM `Marker` value labels in one image. `CLAUDE.md` is explicit that a
  bare `canvas.toDataURL()` drops the markers, because the style ships no glyphs and therefore has
  no symbol layer. The Tauri workaround is `preserveDrawingBuffer: true` plus hand-compositing the
  DOM layer — a rearchitecture of the map export path with a real per-frame cost, in the module
  Phase 5 §7.3 already recommends nobody touch while changing anything else.
- **`dashboardExport.ts`** reads the Chart.js UMD off `node_modules` to inline it into the
  self-contained HTML. There is no `node_modules` in a Tauri bundle; it becomes a bundled resource
  read from Rust. Straightforward, but it is another mechanism replaced.

### 6.3 Testing — the part that worries me most

**MEASURED:** `npm test` is ~3,000 assertions across 43 `scripts/test-*.js` files. Almost all of
them are **Node self-checks importing main-process modules directly** — `test-transforms.js`,
`test-formula.js` (the ~130-assertion formula conformance suite the brief calls the gate),
`test-residentQuery.js`, `test-statsResident.js`, `test-datasetPage.js`, `test-anomaliesResident.js`,
and the differential tests that assert each resident-SQL path matches its pure-JS original with
`Object.is`.

**Every one of those tests dies with the main process it tests.** They do not test a shell; they
test TypeScript modules that would no longer exist. And the differential-test house style —
`CLAUDE.md`: "A resident-SQL module is tested by running the SAME input through it and through the
pure-JS original" — depends on **both implementations being importable from the same runtime**. In
Rust the JS reference implementations are gone, so the tests stop being differential and become
hand-written expected values, which is precisely the weaker thing the house style exists to avoid.

And `npm run smoke`, the only check that runs the real app and the only thing that has ever caught a
CSP violation, is Playwright's `_electron` driver. **RESEARCHED:** `tauri-driver` supports Windows
and Linux directly; macOS has no WKWebView driver and must go through the WebdriverIO service's
embedded server. So the harness is rewritten, on a different framework, against a different driver.

Worse — and this is the specific thing I would not sign off on:

> **CI today runs the smoke test on `ubuntu-latest`, and Chromium on Linux is the same engine as
> Chromium on macOS. Under Tauri it is not: Linux CI would exercise WebKitGTK, macOS users get
> WKWebView, Windows users get Chromium/WebView2. Three engines, and CI tests the one nobody ships
> to.**

For an app with a strict CSP, WebGL2 maps, a 594 KiB vendored Plot bundle and a hard rule that any
renderer console error fails the build, that is a material loss of assurance — in the exact place
this repo has invested the most.

### 6.4 The rest, in one line each

- **Windows.** Five `BrowserWindow` factories, plus `titleBarOverlay` (WCO) repainting on theme
  change (`src/windows/hubWindow.ts:27`), plus an always-on-top full-screen overlay clamped to a
  specific display's bounds with re-asserted focus. Tauri can do all of it; none of it is free.
- **`analyze.ts` / `models.ts` / `localCliRun.ts`.** Six CLI adapters and four BYOK provider
  adapters, each with its own flags, timeouts, stdin/argv conventions and error taxonomy. Pure Rust
  rewrite, no shortcuts.
- **`pg`.** Read-only Postgres with parameterised `information_schema` queries, sub-select +
  `LIMIT`/`statement_timeout`, client closed in `finally`. Either `tokio-postgres` or DuckDB's
  extension (§5.4). The read-only guarantee and the caps must be reimplemented, not assumed.
- **`electron-builder` → `tauri bundler`.** Including the `afterPack` hook that compiles
  `disclaim-exec`, the `afterSign` notarisation hook, hardened runtime, entitlements, and
  `x64ArchFiles`.
- **Phase 5 is mid-flight.** `frontend/`, `tsconfig.svelte.json`, `scripts/build-svelte.js` and a
  Svelte island in the hub are on this branch **right now** (MEASURED). Starting a shell port on
  top of an unfinished renderer port means two simultaneous rewrites of the same surface, with the
  legacy-global bridge from phase-5 §6.2 in the middle of both.

---

## 7. Verdict

### 7.1 Recommendation: **close Phase 6.**

Not "defer" — deferring implies the case gets better later. It does not. The costed benefit is a
one-time ~120 MiB download saving and ~100–200 MB of idle RSS, on a macOS-first desktop app for
developers who downloaded it once, whose actual bottleneck was compute and was fixed in Phase 1–3a
at 206–630×.

Phases 3 and 4 were both re-litigated with numbers, and both times the numbers *moved* the answer:
Phase 3 killed deck.gl on a measurement (45 MB, `@loaders.gl` fetching from unpkg.com) and Phase 4
resurrected MapLibre on a measurement (the objection was `@loaders.gl` and a second fetch host;
neither applies, and the ~1.1 MB size cost was accepted explicitly). This is the same exercise and
it lands the other way.

**The four findings that decide it:**

1. **The size argument is not what it looks like.** MEASURED: Electron is 270 MB of a 561 MB
   install — 48%, not the 90%+ the framework comparison implies. **DuckDB is 224 MB (40%), and
   112 MiB of that is a second architecture's dylib shipped inside the arm64 DMG.** The largest
   single size win available to this product is a packaging fix, not a rewrite. Do that first and
   the remaining Tauri delta is 280–320 MB installed for a full rewrite of the process model.
2. **Security is net negative against *this* app's bar.** §2.1: two invariants strengthened, four
   weakened. The weakest link is inv. 1 — `contextIsolation` has no Tauri equivalent, and the
   capability model does not substitute for it because it authorises *windows*, while the realistic
   threat is a compromised dependency running **inside** the authorised window. This app loads
   twelve third-party browser bundles into the hub. Under Tauri, each of them could call
   `byok:revealKey`.
3. **The highest-risk subsystem has to opt out of Tauri's safety model entirely.** §4: the shell
   plugin's scope requires a literal `cmd`, and this app's whole design is running a
   runtime-resolved user binary. The correct port bypasses the plugin for `std::process::Command`
   — landing outside the capability system, callable by default from any window — and the tempting
   shortcut (`sh -c` with an arg validator) is a hard regression against a `CLAUDE.md` rule.
4. **The verification story gets materially worse.** §6.3: ~3,000 assertions are Node self-checks
   against main-process modules that cease to exist; the differential tests lose the pure-JS half
   they differentiate against; and CI would test WebKitGTK while users run WKWebView. This repo's
   strongest engineering asset is that its performance and correctness claims are all measured. A
   port that starts by deleting the measuring apparatus is a bad trade regardless of the
   destination.

And one meta-point. `CLAUDE.md` says re-litigate with numbers, not opinion. There is a number here
nobody has mentioned: **the port has no user-visible feature in it.** Phase 1 made 1M rows work.
Phase 2 made storage cheap. Phase 3a made queries 206–630× faster. Phase 4 shipped maps. Phase 5
ships a maintainable renderer. Phase 6 ships the same app, smaller. That is the profile of a
project whose remaining phase exists because it was on a list.

### 7.2 Do these instead

Ordered by value per unit of work. Each is independent, revertible, and does not need Rust.

| # | Action | Wins | Cost |
|---|---|---|---|
| 1 | **Stop shipping two DuckDB architectures in a single-arch DMG.** Split into separate `arm64` and `x64` DMGs, or scope the binding install per target. | **~112 MiB installed, ~50–70 MiB download** (MEASURED) | electron-builder config |
| 2 | **Generate the icon map at build time.** `simple-icons` is 15.2 MiB in the asar (MEASURED) and `src/icons.ts` is 78 lines producing a small `{slug: path}` map. Emit that JSON in `build:vendor`; make `simple-icons` a devDependency. | ~15 MiB | half a day; `icons:verify` already exists to guard it |
| 3 | **Rebuild the DMG at HEAD before quoting any size number.** The measured artifact predates the MapLibre swap. MEASURED: `leaflet` is already absent at HEAD, so there is nothing stray to remove — but no one has measured a build with MapLibre and `vendor/vgplot.js` in it. | An accurate baseline | one build |
| 4 | **Kill the `SharedArrayBuffer` bridge without changing shells.** Move DuckDB into a Rust or N-API sidecar over stdio, or wait for a sync API. §5.3's prize — the deletion of `src/duckdb.ts`'s entire control protocol — is available without touching Electron, and it unlocks Arrow. | The one genuine architectural win in Phase 6 | a real project, but bounded, testable, and revertible |
| 5 | **Fix `hub:capture` to be an `invoke` returning `{ started, entryId? }`.** Phase 5 §7.5 identifies it and declines to smuggle a main-process change into a renderer port. It is a small, correct fix on its own. | Deletes `pendingCaptureTarget`, the module global that must survive a full overlay→crop→analyze round-trip | small |
| 6 | **Encrypt the keys if that is wanted.** `safeStorage` (Electron) or the macOS Keychain. §3.4 — nothing about this needs Tauri, and it addresses a real, current, documented weakness that Tauri would *not* have fixed. | Removes plaintext keys from `config.json` | medium; needs a migration |
| 7 | **Fix the `CLAUDE.md` claim in §0.1** and record this document as the place Tauri was actually costed. | Accuracy of the reference the next session reads | minutes |

Items 1 and 2 alone take the installed app from 561 MB to roughly 434 MB and the arm64 download from
200 MiB to somewhere near 130 MiB. Against a full Tauri port's estimated ~145 MB installed / ~72 MiB
download, that is **roughly 30% of the installed-size prize and over half the download prize, for a
day's work and zero architectural risk.**

### 7.3 What would change this verdict

Stated so it is falsifiable rather than a matter of taste. Any *one* of these would reopen it:

- **A second platform becomes primary.** If Linux or Windows becomes a first-class target with real
  users, per-platform Chromium overhead and Electron's update mechanics start to matter, and the
  three-engine testing problem (§6.3) becomes a cost the project is paying anyway.
- **Distribution size becomes a constraint.** Auto-update bandwidth at scale, a corporate deployment
  size cap, or a store limit. Today there is no auto-update pressure and users download once.
- **`@duckdb/node-api` stops being maintained**, or its BOM bug and missing Arrow support start
  costing real work. Then item 4 in §7.2 happens anyway, and once DuckDB is in Rust the marginal
  cost of moving the rest of main follows it.
- **Tauri closes the `contextIsolation` gap.** A supported per-origin or per-script capability
  boundary that survives a compromised in-page dependency — not the iframe isolation pattern with
  its documented bypasses — would remove finding 2, which is the finding I hold most firmly.
- **Someone measures and I am wrong.** The numbers in §5.2 are MEASURED for the current app and
  REASONED for the Tauri side. If a spike produces a real Tauri build of this app with DuckDB
  bundled and it lands under 80 MB installed, the size argument changes shape and this section
  should be rewritten rather than defended.

---

## 8. Sources

Upstream documentation consulted for every **RESEARCHED** claim:

- [Tauri v2 — Capabilities](https://v2.tauri.app/security/capabilities/) — capability/permission
  model; the default that all `invoke_handler` commands are callable by all windows unless
  `AppManifest::commands` is used.
- [Tauri v2 — Content Security Policy](https://v2.tauri.app/security/csp/) — `connect-src ipc:
  http://ipc.localhost`; automatic nonce/hash injection.
- [Tauri v2 — Shell plugin](https://v2.tauri.app/plugin/shell/) — scope entry shape
  (`name`/`cmd`/`args`/`sidecar`), literal `cmd`, arg validators.
- [Tauri v2 — Isolation Pattern](https://v2.tauri.app/concept/inter-process-communication/isolation/)
  — mechanism, Windows inlining requirement, ES-module limitation.
- [Tauri v2 — Inter-Process Communication](https://v2.tauri.app/concept/inter-process-communication/)
  — Commands vs Events.
- [Tauri v2 — Calling the Frontend from Rust](https://v2.tauri.app/develop/calling-frontend/) —
  `emit` broadcasts to all listeners; `emit_to`/`emit_filter`; Channels.
- [Tauri v2 — Configuration reference](https://v2.tauri.app/reference/config/) — `identifier`,
  `withGlobalTauri`, `dangerousDisableAssetCspModification`, `pattern`.
- [Tauri v2 — WebDriver testing](https://v2.tauri.app/develop/tests/webdriver/) — `tauri-driver` is
  Windows/Linux only; macOS has no WKWebView driver.
- [`tauri::path::PathResolver`](https://docs.rs/tauri/latest/tauri/path/struct.PathResolver.html) —
  `app_data_dir()` = `data_dir/${bundle_identifier}`.
- [`tauri::App`](https://docs.rs/tauri/latest/tauri/struct.App.html) — no capture/print/PDF method
  on `Webview`/`WebviewWindow`.
- [GHSA-57fm-592m-34r7](https://github.com/tauri-apps/tauri/security/advisories/GHSA-57fm-592m-34r7)
  — iframes reach Tauri APIs, bypassing the origin check.
- [Radically Open Security — Tauri 2.0 penetration test, Aug 2024](https://fossies.org/linux/tauri/audits/Radically_Open_Security-v2-report.pdf)
  — isolation-frame bypass on Windows/Android.
- [`duckdb` crate](https://docs.rs/duckdb/latest/duckdb/) and
  [duckdb-rs](https://github.com/duckdb/duckdb-rs) — Arrow support (`query_arrow`), `bundled`
  feature compiling from source, ICU excluded from `bundled` under the crates.io 10 MB limit.
- [Tauri v2 — Global Shortcut plugin](https://v2.tauri.app/plugin/global-shortcut/) and
  [tauri-plugin-macos-permissions](https://github.com/ayangweb/tauri-plugin-macos-permissions) —
  macOS Accessibility permission for unfocused shortcuts.
- [xcap](https://github.com/nashaofu/xcap) and
  [tauri-plugin-screenshots](https://crates.io/crates/tauri-plugin-screenshots) — Rust screen
  capture.
- Comparative bundle/memory figures (§5.5) come from third-party 2026 comparison articles
  ([PkgPulse](https://www.pkgpulse.com/guides/electron-vs-tauri-2026),
  [Rustify](https://rustify.rs/articles/rust-tauri-vs-electron-2026)) rather than first-party
  benchmarks, and are cited only to state what the common claim is before explaining why it does
  not transfer to this app. **No weight is placed on them.**

All **MEASURED** figures come from this checkout
(`/Users/ashishb/Projects/ordinate-phase6`) and the built artifacts in
`/Users/ashishb/Projects/ordinate/dist/` (`Screenchart-0.1.0-arm64.dmg`,
`Screenchart-0.1.0-universal.dmg`, `dist/mac-arm64/Screenchart.app`, built 2026-08-01/02 from a
commit predating the MapLibre swap — see the note in §5.1).
