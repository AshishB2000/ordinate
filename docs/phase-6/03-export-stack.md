# Phase 6 · 03 — The export stack under Tauri (landmine 6.4)

**What this is.** Every export path Ordinate ships, what each one actually depends on, what survives
a move to a Tauri shell, what does not, and what the user loses in the documents they hand to
someone else. Landmine 6.4 in
[`.claude/plans/rewrite-to-duckdb-stack.md`](../../.claude/plans/rewrite-to-duckdb-stack.md), plus
landmine 6.7 (`sanitizeBundle`) which is inseparable from it.

**What this is not.** Not the capture loop (landmine 6.3 — screen capture in Rust), not the IPC
port, not the toolchain. Where this document needs a capture primitive it says so and hands the
requirement to 6.3, because **the same Rust window-capture crate solves both problems** (§3.5) and
that is the one genuine synergy between the two landmines.

**Rust is not installed in this worktree and was not installed.** Nothing here was compiled, run, or
measured on a Tauri build. Every load-bearing claim carries a label:

- **[RESEARCHED]** — read out of this repository's source, measured with `wc`/`du`/`grep` on this
  checkout, pulled from the crates.io API, or read from a vendor doc / a tracked upstream issue.
  The evidence is named inline.
- **[REASONED]** — inference from the researched facts. Plausible, unproven, and flagged for the
  cheap experiments in §7.

Nothing in this document is *verified*. §7 lists what to verify first and in what order.

**Status of the source read.** Worktree `/Users/ashishb/Projects/ordinate-phase6`, branch
`feat/phase-6`, at `610e4b5`. Read-only — this file is the only thing this pass wrote. Files read in
full: `src/dashboardExport.ts` (378), `src/reportCapture.ts` (123), `renderer/hub/reportExport.ts`
(785), `src/ipc/{fileSave,dashboardExport,capture,clipboard}.ts` (129/147/54/20), plus the export
halves of `renderer/hub/dashboards.ts` and `renderer/hub/mapRender.ts` (828).

---

## 0. Verdict at a glance

| # | Export path | Verdict | The one thing that breaks it |
|---|---|---|---|
| 1 | Single result → **PDF** | 🟢 **clean path** | nothing — pdfmake already runs in the webview |
| 2 | Single result → **Word** | 🟢 **clean path** | nothing — `docx` already runs in the webview |
| 3 | Single result → **PowerPoint** | 🟢 **clean path** | nothing — pptxgenjs already runs in the webview |
| 4 | Dashboard → **self-contained HTML** | 🟡 **degraded** | `fs.readFile(node_modules/chart.js)`; and the sanitizer changes sides |
| 5 | Single result → **report PNG** | 🟡 **degraded** | offscreen `BrowserWindow` — no macOS equivalent exists |
| 6 | Dashboard → **PNG** | 🟡 **degraded** | same, plus a canvas-area ceiling on tall dashboards |
| 7 | Dashboard → **PDF** | 🟡 **degraded** | `printToPDF` is Chromium-only; Windows has it, macOS does not |
| 8 | **Map → PNG** (feeds 1–7) | 🔴 **no path** as built | `capturePage`; and WKWebView cannot snapshot a WebGL layer at all |
| 9 | Chart PNG download / copy-image | 🟢 **clean path** | nothing — plain 2D `canvas.toDataURL()` |

**The reframe that matters.** Landmine 6.4 says "`pdfmake`, `docx`, `pptxgenjs` … all assume a Node
runtime." **They do not.** All three are loaded in `renderer/hub/index.html` as browser UMD/IIFE
bundles off `node_modules`, run inside the Chromium renderer, and hand `main` a finished base64
string [RESEARCHED — `renderer/hub/index.html:1484-1491`, and every call site in
`renderer/hub/reportExport.ts` reads `window.pdfMake` / `window.PptxGenJS` / `window.docx`]. Tauri
keeps a webview. Three of the four "Node-only" libraries therefore port **unchanged**.

What is actually unportable is not Node. It is **five Electron/Chromium capabilities**, all of them
about *rendering and snapshotting pixels*, none of them about document generation (§3.1). The
landmine is real; it is just aimed one layer too high.

---

## 1. Inventory

### 1.1 The nine paths

| # | Path | Entry point | Generation runs in | Boundary crossing | Save |
|---|---|---|---|---|---|
| 1 | result → PDF | `reportExport.ts:307 exportPdf` | **renderer** (pdfmake) | base64 → `hub:savePdf` | native panel + `fs.writeFileSync` |
| 2 | result → Word | `reportExport.ts:533 exportDocx` | **renderer** (`docx` + JSZip) | base64 → `hub:saveDocx` | same |
| 3 | result → PPT | `reportExport.ts:376 exportPptx` | **renderer** (pptxgenjs + JSZip) | base64 → `hub:savePptx` | same |
| 4 | result → report PNG | `reportExport.ts:618 exportPng` | **split** — HTML in renderer, raster in **main** | HTML string → `hub:captureReport` → `captureHtmlToPng` | PNG data URL back to renderer, then `hub:saveImage` |
| 5 | dashboard → HTML | `dashboards.ts:1440` | **main** (`buildSelfContainedHtml`) | bundle object → `dashboard:exportHtml` | `dialog` + `fs.promises.writeFile` |
| 6 | dashboard → PNG | `dashboards.ts:1455` | **split** — one-pager HTML in renderer, raster in **main** | HTML → `dashboard:exportPng` → `captureHtmlToPng` | main saves directly |
| 7 | dashboard → PDF | `dashboards.ts:1454` | **main** (`printToPDF`) | HTML → `dashboard:exportPdf` → `captureHtmlToPdf` | main saves directly |
| 8 | map → PNG | `reportExport.ts:76 captureMapPNG` | **split** — map drawn in the **visible hub**, snapshotted in main | rect → `hub:captureRegion` → `webContents.capturePage(box)` | feeds 1–7 as a `data:` PNG |
| 9 | chart PNG / copy | `chartControls.ts:118 onDownload`, `:111 onCopyImg` | **renderer** (`canvas.toDataURL`) | data URL → `hub:saveImage` / `hub:copy` | native panel; `clipboard.writeImage` |

Nine paths, **11 IPC channels** [RESEARCHED — `hub:savePdf`, `hub:saveDocx`, `hub:savePptx`,
`hub:saveImage`, `hub:captureReport`, `hub:captureRegion`, `hub:copy`, `dashboard:exportHtml`,
`:exportPng`, `:exportPdf`, `:revealFolder`; preload lines 120–136 and 343–349].

Path 8 is not user-facing on its own. It is a **dependency of paths 1–7**: the export dialog offers
`map_bubble`/`map_choropleth` in its type pool (`reportExport.ts:725`), and
`assembleExportBundle(forCapture)` routes every map card through it (`dashboards.ts:1363`). Break
path 8 and you do not lose one export — you lose maps out of all seven.

### 1.2 What is *actually* Node, and what is Electron

Separating these is the whole analysis. Grepped and read, not assumed:

| Dependency | Where | Node? | Electron? | Portable to a Tauri webview? |
|---|---|---|---|---|
| `pdfmake` 0.3.11 UMD + `vfs_fonts` | renderer `<script src>` | no | no | **yes, unchanged** |
| `pptxgenjs` 4.0.1 bundle (JSZip in) | renderer `<script src>` | no | no | **yes, unchanged** |
| `docx` 9.7.1 IIFE (JSZip in) | renderer `<script src>` | no | no | **yes, unchanged** |
| `chart.js` 4 UMD (rasterizing the chart) | renderer `<script src>` | no | no | **yes, unchanged** |
| `canvas.toDataURL`, `btoa`/`atob`, `Image` | renderer | no | no | **yes** |
| `buildSelfContainedHtml` / `sanitizeBundle` | `src/dashboardExport.ts` | **pure TS, zero imports** | no | yes — but see §4.2, it must not simply move |
| `fs.readFile(app.getAppPath()/node_modules/chart.js/…)` | `ipc/dashboardExport.ts:33` | **yes** | yes (asar) | **no** — §4.4 |
| `dialog.showSaveDialog` + `fs.write*` | `ipc/fileSave.ts`, `ipc/dashboardExport.ts` | yes | yes | yes → `tauri-plugin-dialog` + `-fs` |
| `clipboard.writeImage` + `nativeImage` | `ipc/clipboard.ts` | no | **yes** | yes → clipboard-manager plugin (§2.9) |
| **hidden `BrowserWindow`** (`paintWhenInitiallyHidden`, `enableLargerThanScreen`, `setContentSize` to 8000 px) | `reportCapture.ts:29-47,72` | no | **yes** | **no** — §3 |
| **`webContents.capturePage()`** (whole page, composited, 2×) | `reportCapture.ts:90` | no | **yes** | **no** — §3.2 |
| **`webContents.capturePage(box)`** (region of the visible hub, incl. WebGL) | `ipc/capture.ts:33` | no | **yes** | **no** — §3.5 |
| **`webContents.printToPDF()`** | `reportCapture.ts:111` | no | **yes** | **Windows only** — §2.2 |
| `webContents.executeJavaScript` (the settle barrier) | `reportCapture.ts:55-77` | no | yes | moot if the offscreen window goes |

**Four items are genuinely Node** (three of them `fs` writes and one `fs` read), and all four are a
one-for-one swap to a Tauri plugin. **Five are Electron/Chromium rendering capabilities**, and those
are the whole of landmine 6.4.

### 1.3 Sizes, because they set the bundling budget

[RESEARCHED — `du -h` on this checkout]

| bundle | size | needed for |
|---|---:|---|
| `docx/dist/index.iife.js` | 1.1 MB | Word |
| `pdfmake/build/pdfmake.min.js` | 1.0 MB | PDF |
| `pdfmake/build/vfs_fonts.js` | 836 KB | PDF (Roboto, embedded) |
| `pptxgenjs/dist/pptxgen.bundle.js` | 452 KB | PPT |
| `chart.js/dist/chart.umd.min.js` | 204 KB | inlined into every HTML export |
| **total loaded eagerly on hub start today** | **≈3.4 MB** | |

All four export bundles are unconditional `<script src>` tags today. Phase 5 put **esbuild** in the
toolchain [RESEARCHED — `package.json` `build:svelte`, `scripts/build-svelte.js`,
`docs/phase-5/01-toolchain.md §1`], so lazy-loading them on first export is now a two-line change
and no longer needs a new tool. Out of scope for parity; worth one commit afterwards.

---

## 2. Per-format options

### 2.0 The four strategies, and when each is honest

- **A — keep it in the webview.** The library is already a browser build; Tauri keeps a webview.
  Zero output change. Only fails if the library needs a Chromium-only API.
- **B — a Rust crate.** Rust owns the bytes, the webview sends structured data. Better for the
  security boundary (§4.2), worse for output fidelity, and every crate is a *writer*, not a *layout
  engine* — you re-implement layout, and the document a user hands to a colleague changes.
- **C — a bundled Node sidecar.** Ship a Node binary as a Tauri sidecar and keep `pdfmake`/`docx`/
  `pptxgenjs` running under it. **Rejected outright for this repo**: ~40–100 MB of runtime added to
  fix a problem that does not exist (A already works), a second process to sandbox and sign, and a
  `spawn` of a bundled interpreter in an app whose security section says the shell-free `execFile`
  rule exists so "no user/AI/config string ever becomes a command". Mentioned only to close it.
- **D — drop the format.** Invariant 9 names PDF/Word/PPT/HTML/PNG explicitly. Dropping any is a
  gate failure, not a trade. Listed per format only to quantify what a drop would cost.

### 2.1 Single result → PDF · **strategy A**

Today: `buildReportDoc` (`reportExport.ts:246`) → pdfmake doc definition → `getBase64()` →
`hub:savePdf`. Output: A4, 36 pt margins, embedded Roboto, vector text, the brand mark as **vector
SVG** (pdfmake parses `{svg}` natively — the comment at `:234` records that this is why the PDF kept
a crisp logo while Word/PPT had to rasterize it), bold runs for the computed figures, a page-count
footer.

Under Tauri: unchanged. pdfmake is pure JS, uses no Node API, no Worker, no `URL.createObjectURL`
[RESEARCHED — grepped the shipped bundle: 0 `new Worker`, 0 `createObjectURL`, 0 bare `eval(`]. Its
one `new Function("return this")` is the standard `globalThis` polyfill inside a `try/catch` with a
`typeof window` fallback [RESEARCHED — grepped with context], which is exactly why it already
survives `script-src 'self'` with no `unsafe-eval` today; WKWebView enforces the same CSP semantics
[REASONED].

**Output quality: identical.** The Rust alternatives are strictly worse and should not be
considered here: `printpdf` (2.1 M downloads, v0.12.5, active) and `pdf-writer` (2.7 M, v0.15.0) are
low-level writers with no text layout, no line breaking, no SVG. `typst` + `typst-pdf` (1.9 M /
1.7 M, v0.15.1, active) is a genuine typesetting engine with excellent output — but its input is
Typst markup, so adopting it means rewriting the report template in a third language and shipping a
font stack, to replace a path that already works [RESEARCHED — crates.io API, queried this session].

### 2.2 Dashboard → PDF · **the one real fork**

Today this is the *only* PDF that does not go through pdfmake: `dashboards.ts` builds a one-pager
HTML with a CSS grid, main renders it in the hidden window and calls Chromium `printToPDF`
(`reportCapture.ts:111`). Output: real CSS-grid layout, selectable vector text for titles / metric
values / text cards, card PNGs embedded as images, landscape, printed backgrounds.

`printToPDF` has **no cross-platform Tauri equivalent** [RESEARCHED]:

- wry issue #707 ("print webview to pdf silently") — opened 2022-09-29, **still open**, one comment
  which states the position exactly: WebView2's `PrintToPdfAsync` covers Windows only, macOS
  WKWebView's `createPDF` returns a per-page document you must stitch yourself, WebKitGTK needs
  `print_to_stream` with a custom `PrintOperation` — "three different code paths, not one feature."
- tauri issue #12284 ("PDF generation programmatically") — opened 2025-01-07, **zero comments**.
- plugins-workspace #293 ("add plugin for (silent) print API") — opened 2023-03-31, 17 comments,
  **still open**.

Three options, ranked:

1. **Build the dashboard PDF with pdfmake, in the webview** — the same engine paths 1–3 already
   use. The 12-column grid maps onto pdfmake `absolutePosition` (x/y in points from the card's
   `layout`), so **grid fidelity is achievable**, not approximated. Metric values, card titles and
   text cards stay **vector text**; image cards were already PNGs. Quality delta: pdfmake's font
   metrics and wrapping differ from Chromium's, so long text cards will break lines differently, and
   `overflow: hidden` clipping on an oversized card has no pdfmake analogue and must be emulated by
   truncation. **[REASONED]** Verdict: small, visible-if-you-diff, invisible-if-you-don't.
2. **A per-platform Rust plugin over the native webview print API.** Reachable — wry exposes the
   raw `WKWebView` through `objc2_web_kit` on macOS and the `ICoreWebView2` controller through
   `with_webview` on Windows [RESEARCHED — wry docs / DeepWiki]. But it inherits *the offscreen
   problem* (§3.3): on macOS the webview must be on-screen to have rendered at all, and WebView2's
   `PrintToPdfAsync` renders the **current viewport layout**, so a responsive page prints at window
   width unless print media is forced [RESEARCHED — the wry #707 comment names this trap
   specifically]. Three code paths, three failure modes, for a format option 1 already covers.
3. **Rasterize the one-pager to a PNG and wrap it in a PDF.** Cheapest and the worst: every word in
   the document stops being text. Unsearchable, unselectable, blurry when printed. This is a real
   product regression and should be the fallback of last resort, not the plan.

**Recommendation: option 1.** It also collapses two PDF engines into one.

### 2.3 Single result → Word · **strategy A**

Today: `buildReportDocx` (`reportExport.ts:419`) → `docx` → `Packer.toBase64String`. Output: a real
editable `.docx` — a borderless 2-column header table whose bottom border *is* the accent rule (the
comment at `:438` records that an empty-paragraph border was tried and some editors dropped it), A4
in twips, bold runs on the computed figures, the chart sized to content width from its natural
pixel dimensions, and a footer using genuine `PAGE`/`NUMPAGES` field codes.

Under Tauri: unchanged. Same evidence as §2.1 (0 workers, 0 blob URLs; the single `eval` hit is
inside the bundled JSZip's setImmediate shim, in a branch guarded by a `typeof` check, and again
already lives under `script-src 'self'` today [RESEARCHED — grepped]).

**The Rust alternative is a real downgrade, and it is worth naming why.** `docx-rs` is the mature
choice — 3.0 M downloads, 1.05 M in 90 days, v0.4.22, last published 2026-07-21, alive since 2020
[RESEARCHED — crates.io]. `docx-rust` is comparable (2.2 M / 571 K). Both write paragraphs, runs,
tables and images competently. What is at risk in *this* document specifically: the field-code
footer (`PAGE of NUMPAGES`), per-cell border overrides used to draw the accent rule, and image
sizing in EMU. Each is individually solvable; together they are a re-implementation of a 110-line
document builder that currently works, in a language with no `npm test` coverage in this repo. **Do
not port Word to Rust to satisfy a landmine that does not apply.**

### 2.4 Single result → PowerPoint · **strategy A, and here there is no alternative**

Today: `buildReportPptx` (`reportExport.ts:336`) → pptxgenjs `LAYOUT_WIDE`, two slides, brand
lockup, mixed bold/regular text runs, `sizing: {type:'contain'}` on the chart image.

Under Tauri: unchanged.

**There is no mature Rust PPTX writer.** [RESEARCHED — crates.io API, this session]

| crate | version | total dl | 90-day dl | first published |
|---|---|---:|---:|---|
| `ppt-rs` | 0.2.24 | 55,695 | 37,347 | 2025-11 |
| `pptx` | 0.1.0 | 4,107 | 3,754 | 2026-02 |

Compare `docx-rs` at 2.99 M total. Both PPTX crates are months old with four-to-five-figure download
counts; neither is something to put a user-facing deliverable on. The remaining Rust option is
hand-rolling OOXML with `zip` + `quick-xml` — i.e. re-implementing pptxgenjs. **PPTX is the format
that most decisively proves strategy A**: keep the library in the webview and the question never
arises.

### 2.5 Dashboard → self-contained HTML · **strategy A for assembly, but see §4**

Today: renderer assembles a bundle (`assembleExportBundle(false)`), main sanitizes it, inlines the
Chart.js UMD read off `node_modules`, and writes one offline `.html`. Core Chart.js cards render
**live** from inlined `{labels, series}`; everything else arrives as a `data:` PNG.

Two independent Tauri problems, both fixable:

- **the Chart.js supply** — `fs.readFile(app.getAppPath()/node_modules/…)` has no meaning in a Tauri
  bundle. §4.4.
- **the sanitizer changes sides** — the whitelist currently runs on the far side of the IPC boundary
  from the untrusted producer. §4.2. This is the part that is easy to get wrong quietly.

Output quality is unaffected by either, *provided* Chart.js still gets inlined. If it does not, the
degradation is already coded: every chart card renders a "Chart engine unavailable" tile
(`dashboardExport.ts:309`) — the export still opens, and every live chart is gone. **8 of 25
non-map chart types render live** today (`DASH_EXPORT_LIVE_TYPES`, `dashboards.ts:1275`); the other
17 charts plus 2 maps plus the table are already PNGs, so losing the library costs the interactive
half of the file, not the file.

### 2.6 / 2.7 Report PNG and dashboard PNG · **the offscreen renderer** → §3

### 2.8 Map → PNG · **the one with no path as built** → §3.5

### 2.9 Chart PNG download, copy-image · **strategy A**

`getLiveCanvas().toDataURL('image/png')` on a Chart.js 2D canvas — portable to any webview
[RESEARCHED — `chartControls.ts:112,119`]. Saving swaps to `tauri-plugin-dialog` + `-fs`. Clipboard
image needs `tauri-plugin-clipboard-manager`, which does support writing an image buffer in v2
[RESEARCHED — Tauri v2 clipboard-manager reference], replacing `clipboard.writeImage` +
`nativeImage.createFromDataURL` (`ipc/clipboard.ts:8`). Note this path never touches a map: the ⋯
download menu is a Chart.js affordance.

### 2.10 Crate reference (queried live, this session) [RESEARCHED]

| crate | v | total dl | 90-day | last publish | relevance |
|---|---|---:|---:|---|---|
| `printpdf` | 0.12.5 | 2.08 M | 944 K | 2026-07-29 | PDF writer, no layout engine |
| `pdf-writer` | 0.15.0 | 2.74 M | 1.25 M | 2026-05-27 | low-level PDF, Typst ecosystem |
| `typst` / `typst-pdf` | 0.15.1 | 1.89 M / 1.67 M | 806 K / 705 K | 2026-07-17 | real typesetting; new input language |
| `krilla` | 0.8.2 | 1.20 M | 758 K | 2026-06-04 | PDF backend under typst-pdf |
| `genpdf` | 0.2.0 | 521 K | 157 K | **2021-06-17** | layout on printpdf — **unmaintained** |
| `docx-rs` | 0.4.22 | 2.99 M | 1.05 M | 2026-07-21 | best Rust DOCX |
| `docx-rust` | 0.1.11 | 2.18 M | 571 K | 2026-01-22 | alternative DOCX |
| `ppt-rs` | 0.2.24 | 55.7 K | 37.3 K | 2026-08-01 | PPTX — too young |
| `pptx` | 0.1.0 | 4.1 K | 3.8 K | 2026-02-25 | PPTX — too young |
| `resvg` | 0.47.0 | 20.9 M | 7.61 M | 2026-02-09 | SVG→PNG, very mature |
| `image` | 0.25.10 | 161 M | 39.4 M | 2026-03-10 | PNG encode + **strip stitching** (§3.4) |
| `xcap` | 0.9.8 | 1.33 M | 655 K | 2026-08-01 | **window/monitor capture** (§3.5) |
| `scap` | 0.0.8 | 32 K | 7.3 K | 2025-08-04 | ScreenCaptureKit wrapper — young |
| `plotters` | 0.3.7 | 199 M | 44.4 M | **2024-09-08** | Rust charting — *not* a Chart.js substitute |
| `headless_chrome` | 1.0.22 | 2.80 M | 887 K | 2026-06-11 | **drives an externally installed Chrome — violates invariant 1** |

`headless_chrome` deserves an explicit no: it would restore `printToPDF` and full-page capture
perfectly, and it does so by requiring a Chrome the user installed separately, or by bundling one —
which is Electron with extra steps, in a phase whose premise is removing Electron.

---

## 3. The offscreen renderer — the hard one

### 3.1 What `reportCapture.ts` actually relies on

123 lines, five distinct Electron capabilities [RESEARCHED — read in full]:

1. **A window that paints while hidden.** `show: false` + `paintWhenInitiallyHidden: true` +
   `backgroundThrottling: false` (`:39-45`).
2. **A window bigger than the screen.** `enableLargerThanScreen: true` (`:35`), then
   `setContentSize(w, min(8000, scrollHeight))` (`:72`) after measuring the laid-out page.
3. **Script injection into that window** for the settle barrier — await `document.fonts.ready`, await
   every incomplete `document.images` entry with a 3 s cap, then two `requestAnimationFrame`s
   (`:55-77`).
4. **`capturePage()`** on the whole page, at the display scale factor, returning a `NativeImage`
   (`:90`).
5. **`printToPDF()`** (`:111`).

And a sixth, in `ipc/capture.ts`: **`capturePage(box)` on the visible hub**, which snapshots the
*composited* page so a WebGL layer and its DOM siblings come back in one image.

The file's own header states the invariant that makes it safe: the HTML it renders is **raster
only** — no MapLibre is ever constructed inside it, because a hidden window is "the least reliable
place to run WebGL" and because `document.images` is the wrong idle barrier for a GL map. That
design decision is what makes §3.4 tractable: **the offscreen window never needed a GPU.**

### 3.2 What Tauri offers, per platform

| capability | macOS (WKWebView) | Windows (WebView2) | Linux (WebKitGTK) |
|---|---|---|---|
| render while hidden/offscreen | **no** [RESEARCHED — Apple's own position: WKWebView renders only when the control is visible and in the view hierarchy; it "does not expose enough public API to support offscreen rendering"] | partial [REASONED — Chromium-backed; visibility/occlusion throttling still applies] | unclear [REASONED] |
| window larger than screen | needs `objc` (`constrainFrameRect`) [REASONED] | possible [REASONED] | possible [REASONED] |
| snapshot the composited page | **no public API** | `CapturePreview` — **viewport only**, offscreen content excluded [RESEARCHED — WebView2Feedback #733] | no |
| snapshot including a **WebGL layer** | **NO** — `takeSnapshot` is a *software* snapshot; WebKit's own source documents that hardware-accelerated layers (WebGL, video) are not captured [RESEARCHED] | yes, within the viewport [REASONED] | no |
| silent print → PDF | `WKWebView.createPDF`, per-page, must be stitched [RESEARCHED — wry #707] | `ICoreWebView2_7::PrintToPdf` [RESEARCHED — MS Learn] | `print_to_stream` [RESEARCHED — wry #707] |
| a first-party Tauri API for any of the above | **none** — tauri #12879 (`[feat] capturePage`, opened 2025-03-03) is open with exactly one comment, which is a link to the `xcap` crate [RESEARCHED — GitHub API, this session] | same | same |

Third-party plugins exist (`tauri-plugin-screenshots`, `tauri-plugin-snapshot`) but they capture
*windows and monitors via the OS*, not the webview's own render tree [RESEARCHED] — which is §3.5's
approach, not §3.4's, and carries §3.5's permission cost.

### 3.3 The WKWebView double bind

macOS is this project's primary target ("macOS-first"), and on macOS the two facts compose into a
dead end for the current design:

> **It will not render unless it is visible, and if you make it visible you still cannot snapshot a
> WebGL layer out of it.**

There is no arrangement of hidden windows, negative coordinates, or transparent overlays that gets
past both. Anything that tries is fighting the platform, and it will break on a macOS update. **Stop
trying to replace the offscreen window and replace what it was *for*.**

### 3.4 The replacement: rasterize inside the visible page

The offscreen window exists to turn a **self-contained, raster-only, script-free HTML string** into
a PNG. Nothing about that requires a second window. The page already has a canvas API.

**Recommended: draw the one-pager onto a `<canvas>` in the hub, in a hidden container, and read it
back.** Two ways to get there, and the choice matters:

- **(a) SVG `foreignObject` → `<img>` → `drawImage`** (the `html-to-image` technique). Keeps the
  existing HTML/CSS templates verbatim. Needs no new native capability, no permission, no CSP
  change beyond what `data:` already allows. **Risk: WebKit.** Safari has a long history of
  `foreignObject` rasterization defects — most relevantly, images inside a `foreignObject` and any
  style not inlined onto the element. Since the templates already inline every style and every
  image is a `data:` URI, this is closer to the happy path than usual, but it is exactly the class
  of thing that works in Chromium and quietly produces a half-blank PNG in WKWebView. **[REASONED —
  verify first, §7.]**
- **(b) Draw the templates directly with the 2D context.** Both templates are fixed and simple:
  `buildReportHtml` is header / accent rule / paragraph / headline with bold runs / one image /
  footer, and `buildDashCaptureHtml` is a 12-column grid of four card kinds. Roughly 200–300 lines
  of `fillText` / `measureText` / `drawImage`, deterministic, identical on every platform, and it
  removes the HTML template as an intermediate entirely. **Cost:** hand-rolled word wrapping, and
  the report template's typography (`-apple-system` at 13.5 px, line-height 1.5, bold runs inside a
  flowing paragraph) has to be re-derived. **This is the boring answer and probably the right one.**

Either way, **two Electron dependencies disappear**: no hidden window, no `capturePage` for paths
4/6/7. Rust's job shrinks to *receive bytes, show a save panel, write the file*.

**One concrete new risk: the canvas-area ceiling.** Today the offscreen window is sized to
`min(8000, scrollHeight)` px and captured at 2× — up to 2320 × 16000 device pixels for a 1160 pt
dashboard, ≈37 MP. WebKit caps total canvas area and silently hands back a blank or downscaled
canvas past the cap rather than throwing. A tall multi-page dashboard is exactly the document that
hits it. **Mitigation: render in vertical strips of ≤4096 device px, send each strip to Rust, and
stitch with the `image` crate** (161 M downloads, entirely routine). Doing this from day one is
cheaper than discovering it on a user's 6-page dashboard. **[REASONED — the cap is real and
platform-specific; the exact WebKit number needs measuring, §7.]**

For the **dashboard PDF**, §2.2 option 1 removes the raster path entirely — pdfmake takes the same
card list and produces vector text. The strip-stitching problem then applies only to the PNG.

**A CSP detail that will bite.** `buildDashCaptureHtml` emits `style="grid-column:… ;grid-row:…"`
inline on every card, and the comment at `dashboards.ts:1375` says why that is legal: *"Rendered in
an OFFSCREEN sandboxed window (its own `data:` origin — the hub CSP does not apply)."* Move that
HTML into the hub and `style-src 'self'` blocks every one of those attributes — the grid collapses
to a single column and, because `npm run smoke` fails on any renderer console error, it fails loudly
rather than silently. The fix is the house rule already in `CLAUDE.md`: JS `element.style.x` is
allowed, inline `style=` is not. Approach (b) sidesteps it completely. **[RESEARCHED —
`renderer/hub/index.html:14`, `dashboards.ts:1373-1390`.]**

### 3.5 Map → PNG without `capturePage`

The hardest single item, and the reason path 8 is red.

What must end up in the image [RESEARCHED — `mapRender.ts`]: the **WebGL canvas** (raster OSM tiles,
circle/fill layers) *plus* four kinds of **DOM sibling** — value labels, which are MapLibre
`Marker`s (`.cv-map-value-label`, created at `:340-345`, because with no `glyphs` URL there is no
symbol layer), the legend (`.cv-map-legend`, `:753`/`:784`), the unmatched-places note
(`.cv-map-unmatched`, `:680`), and **the OSM attribution control** (`attributionControl: {compact:
true}`, `:296`). That last one is not decoration: OSM tile usage requires attribution, so an export
path that drops it is a licensing problem, not a cosmetic one.

Today `capturePage(box)` gets all five in one shot because it reads the composited surface. Options
in order of preference:

1. **Composite in JS: GL readback + re-projected overlays.** The map is already created with
   `preserveDrawingBuffer: true` (`mapRender.ts:290`), so `map.getCanvas().toDataURL()` returns the
   GL layer — this is the existing degraded fallback (`reportExport.ts:131 captureMapCanvasPNG`),
   and the honest description of it today is "loses the DOM legend/notes, but a map without its
   legend beats no map at all." **Promote it to primary and close the gap**: every dropped element
   has a known position — value labels have `lng`/`lat`, so `map.project()` gives exact pixels; the
   legend, note and attribution are fixed-corner boxes. Draw them onto the 2D compositing canvas
   that `captureMapCanvasPNG` already creates. **No new permission, no new dependency, works in every
   webview, deterministic.** Cost: the label chip / legend styling is re-implemented in canvas and
   will drift from the CSS unless someone keeps them in step. **[REASONED — the primitives are all
   present in the current code; only the drawing pass is new.]**
2. **OS window capture from Rust — `xcap`.** 1.33 M downloads, v0.9.8, published 2026-08-01, and
   *the single comment on Tauri's own `capturePage` issue is a link to it* [RESEARCHED]. Captures a
   named window from the window server, which **does** include GPU-composited layers — the exact
   thing `takeSnapshot` cannot do. **This is where landmines 6.3 and 6.4 converge**: 6.3 must ship a
   Rust screen-capture stack anyway, and the same crate serves both. The map is *already* rendered
   in the visible hub during export (`.export-map-capture` is `position: fixed; top:0; left:0;
   z-index:100000` — the user sees it flash), so there is no new UX cost. **Real costs:** it needs
   the Screen Recording permission, which couples map export to a permission a user could
   previously decline while still exporting maps; per-window capture must exclude overlapping
   windows (macOS `SCContentFilter` on a window, or `CGWindowListCreateImage` with
   `kCGWindowListOptionIncludingWindow`) or a notification banner lands in someone's report; and
   the DPI/scale mapping from CSS px to captured px must be got right or the crop is off.
   **[RESEARCHED for the crate and the API surface; REASONED for the per-window exclusion behaviour
   under Tauri.]**
3. **Give up on live maps in exports and ship a static raster.** Re-fetch the OSM tiles in Rust,
   compose them with `image`, draw circles/fills from the same `geo` data. This is writing a map
   renderer. Rejected.

**Recommendation: 1 as primary, 2 as fallback** — the mirror image of today's arrangement
(`capturePage` primary, canvas readback fallback), and it inverts cleanly because the existing
`isUniformImage` check (`reportExport.ts:158`) is already the arbiter of "did this come back blank".
Keep that check. It is the one thing standing between a failed capture and a blank rectangle in
someone's board deck.

### 3.6 If neither works

Then `map_bubble` and `map_choropleth` — **2 of 28 chart/map types** — become non-exportable, in all
five formats plus the dashboard HTML and the dashboard PNG/PDF. The dashboard degradation is already
implemented and graceful: `buildVisualExportCard` returns `{kind:'broken', reason:'Chart could not
be rendered'}` (`dashboards.ts:1367`) and the card renders as a dashed "Unavailable" tile. The
single-result dialog already refuses rather than embedding a blank: *"Couldn't capture the map — try
again, or pick a chart for the report"* (`reportExport.ts:757`). So the failure mode is honest
today, which means shipping without map export is *possible*. It is still a Phase 4 feature
regressing one phase later, and Phase 4's gate said in as many words: "both map types render **and
export**."

---

## 4. `sanitizeBundle`, and where Chart.js comes from

### 4.1 What the control is

`sanitizeBundle` (`src/dashboardExport.ts:209`, ~116 lines of whitelisting) takes untrusted renderer
input and rebuilds it field-by-field into a fixed primitive schema. The properties that matter:

- **It is a rebuild, not a filter.** Unknown keys are not deleted — they are never copied. A card of
  unknown `kind` returns `null` and is dropped (`:191`).
- **`sanitizePng` accepts only `/^data:image\/[a-z0-9.+-]+;base64,/i`** (`:154`) — no `http(s)`, so
  the file stays offline and cannot beacon.
- **`asNumOrNull` admits only finite numbers** (`:129`) — a string in a data cell becomes `null`,
  so a leaked secret cannot ride in as a value.
- **`chartType` is checked against an 8-entry set** (`:89`), and layout ints are clamped to the grid.
- **`embedJson` escapes `<`, `>`, U+2028/29** (`:220`) so nothing breaks out of the `<script>`.
- The whole file imports nothing — no `fs`, no `electron`, no DOM — which is why
  `scripts/test-dashboardExport.ts` can `require` it under plain node and assert with a sentinel
  string that non-schema fields never reach the output (22 assertions) [RESEARCHED].

### 4.2 The boundary moves — and that is the actual risk

Today the trust boundary is: **renderer produces the bundle → IPC → main sanitizes → main writes.**
The sanitizer sits on the far side of the boundary from the thing that might be wrong.

The tempting Tauri port is "move `buildSelfContainedHtml` into the webview, have Rust write the
bytes." That keeps every assertion in `test-dashboardExport.ts` green **and silently deletes the
security property**, because a compromised or merely buggy webview now hands Rust finished HTML and
Rust writes whatever it is given. The tests would not notice. That is the failure mode landmine 6.7
is warning about.

Three ways to keep the control where it is:

- **Port `sanitizeBundle` + `buildSelfContainedHtml` to Rust; keep the TS as the reference.** ~380
  lines of pure string/JSON work — `serde_json::Value` in, a `struct` out, no crates beyond serde.
  **This is exactly the pattern the repo already runs** for every resident-SQL module: two
  implementations, the JS one is the reference, and a *differential* test asserts they agree
  value-for-value. Port `test-dashboardExport.ts`'s sentinel corpus to feed both and compare output
  bytes. **Recommended.**
- **Keep the TS sanitizer in the webview but re-validate in Rust.** Cheaper: Rust re-checks the few
  invariants that carry the weight — the `data:image` prefix on every embedded image, no `http`/
  `https` scheme anywhere in the output, and a size cap. Weaker (a Rust-side regex over finished
  HTML is a filter, and filters are what the current design deliberately avoided), but far better
  than nothing and a legitimate interim.
- **Run the TS in an embedded JS engine** (`boa`, `deno_core`). Names an option only to reject it:
  a whole JS runtime, in Rust, to avoid porting 380 lines, in a repo whose invariant 7 is "no `eval`,
  no `new Function`, anywhere."

**Whichever is chosen, the property to state and test is:** *no byte reaches an exported file
without having been reconstructed, on the Rust side, from a value that matched the schema.*

### 4.3 Preservation, per replacement path

| replacement | does the whitelist still apply? | what to add |
|---|---|---|
| §2.1–2.4 webview PDF/Word/PPT (unchanged) | **n/a — they never had one.** The renderer builds bytes and main writes them verbatim today (`ipc/fileSave.ts`) | nothing changes; note the asymmetry honestly rather than claiming a control that never existed |
| §2.5 HTML via Rust `buildSelfContainedHtml` | **yes, preserved by construction** | differential test vs the TS reference |
| §2.5 HTML assembled in the webview | **no — silently lost** | §4.2 option 2 at minimum |
| §3.4 canvas rasterization (report/dash PNG) | n/a — output is pixels, and pixels cannot carry a config field | keep the strict-number rule upstream, where it already is |
| §2.2 dashboard PDF via pdfmake | **no** — same asymmetry as PDF today | the card list handed to pdfmake should be `sanitizeBundle`'s output, not the raw bundle. One line, easy to forget |
| §3.5 map PNG | n/a | keep `isUniformImage`; a blank map must fail, not embed |

The `dashboard:revealFolder` handler (`ipc/dashboardExport.ts:125`) is a separate control — UUID
regex plus a `path.dirname(dir) !== projectsBase` check. It ports to Rust unchanged and must keep
**both** halves; Rust's `PathBuf` does not validate anything for you.

### 4.4 Where the inlined Chart.js comes from

`chartLibPath()` = `app.getAppPath()/node_modules/chart.js/dist/chart.umd.min.js`, 204 KB, read with
`fs.promises.readFile` at export time, tolerant of failure [RESEARCHED —
`ipc/dashboardExport.ts:32-72`]. In a Tauri bundle there is no `node_modules` and no asar. Three
replacements:

1. **Commit a vendored copy and ship it as a Tauri resource**, read at export time via the fs
   plugin (or the resource resolver). **This is the precedent the repo already set**:
   `renderer/hub/vendor/vgplot.js` and `plot.css` are committed build artifacts produced by
   `npm run build:vendor`, specifically so CI and the packager do not need the dependency tree
   [RESEARCHED — `CLAUDE.md`, "Testing and Commands"]. Extend that script to emit
   `vendor/chart.umd.min.js` and make it fail loudly if the source moves — the same discipline
   `build-vendor.js` already applies to Plot's `<style>` patches.
2. **`include_str!` it into the Rust binary.** 204 KB of `&'static str`, zero I/O, zero failure
   mode, and the export can never half-work. Slightly less discoverable; a version bump needs a
   rebuild, which it needs anyway.
3. **`fetch()` it in the webview** from the app's own asset origin, then pass the text in with the
   bundle. Keeps everything in one place, but it adds `connect-src 'self'` to the hub CSP and — more
   importantly — it makes the *library text* renderer-supplied input on a path whose whole point is
   that main controls what goes in the file. **Do not do this.**

**Recommendation: 1 for consistency with `build:vendor`, 2 if the export moves fully into Rust.**
Either way keep the existing tolerant failure: a missing library degrades to "Chart engine
unavailable" tiles, it does not fail the export (`dashboardExport.ts:309`).

---

## 5. Parity verdict per format

Invariant 9 lists "report export (PDF/Word/PPT/HTML/PNG)". Scoring each, with the loss quantified.

| Format | Verdict | Strategy | Output-quality delta | What is lost if the plan fails |
|---|---|---|---|---|
| **Result → PDF** | 🟢 clean path | A — pdfmake in webview | **none** | — |
| **Result → Word** | 🟢 clean path | A — `docx` in webview | **none** | — |
| **Result → PPT** | 🟢 clean path | A — pptxgenjs in webview | **none** | the whole format: no mature Rust PPTX writer exists (§2.4) |
| **Result → PNG** | 🟡 degraded | in-page canvas (§3.4) | text rendering moves from Chromium layout to canvas `fillText`; wrapping and hinting differ. Same 2× resolution, same content | the format; there is no other way to make a full-page raster without an offscreen renderer |
| **Dashboard → HTML** | 🟡 degraded | A + Rust sanitizer (§4.2) + vendored Chart.js (§4.4) | **none if Chart.js is inlined.** If not: 8 of 25 non-map types stop being live and become "Chart engine unavailable" tiles | the interactive half of the file; the file still opens and still shows 20 of 28 card types as PNGs |
| **Dashboard → PNG** | 🟡 degraded | in-page canvas + **strip stitching** (§3.4) | as Result → PNG, plus a real risk of a silent blank canvas on tall dashboards if strips are skipped | the format for large dashboards only — small ones would still work, which is the worst kind of bug |
| **Dashboard → PDF** | 🟡 degraded | pdfmake with `absolutePosition` (§2.2) | grid geometry preserved; **text stays vector**; line-breaking differs from Chromium; `overflow:hidden` card clipping must be emulated | fall back to raster-in-a-PDF → **every word stops being selectable or searchable**. That is a genuine product regression |
| **Map → PNG** | 🔴 **no path as built** | JS composite primary, `xcap` fallback (§3.5) | option 1 re-implements label/legend/attribution drawing in canvas — visual drift from the CSS is the risk | **2 of 28 types lose export in all 7 paths.** Failure is already graceful in code, and it reverses a Phase 4 gate commitment |

**Score: 3 clean, 4 degraded, 1 with no path as built.** No format needs to be dropped. Every 🟡 is
"same document, different renderer" rather than "less document" — except dashboard PDF, where the
fallback-of-last-resort would flatten text to pixels, and that one should be treated as
unacceptable rather than degraded.

**One parity item that improves:** two PDF engines (pdfmake + `printToPDF`) collapse to one.

---

## 6. The single biggest unsolved problem

**Getting a WebGL map into an exported document on macOS.**

Not the offscreen renderer — that one has an answer, and it is a good one: the offscreen window was
only ever rasterizing a script-free, raster-only page, so drawing the same content onto a canvas in
the visible hub replaces it with *less* machinery, not more (§3.4). Everything else on the list is
either already portable (PDF/Word/PPT/chart PNG), a plugin swap (dialogs, fs, clipboard), or a
build-time asset move (Chart.js).

The map is different, because two independent platform facts compose:

1. **WKWebView renders only when visible** — Apple's stated position, not a Tauri bug [RESEARCHED].
2. **WKWebView's snapshot API is software-only and does not capture hardware-accelerated layers**
   — documented in WebKit's own source [RESEARCHED].

Together: on macOS there is **no webview-level way to get pixels out of a MapLibre render, visible
or not.** Electron sidesteps this only because Chromium's compositor is in-process and
`capturePage` reads the compositor. Tauri has no equivalent and no first-party plan — `[feat]
capturePage` has been open since March 2025 with a single comment linking to `xcap` [RESEARCHED].

Both escapes have a cost that is not an implementation detail:

- **JS compositing** (GL readback + re-projected labels) works everywhere and needs no permission,
  but it means the legend, the value chips, the unmatched-places note and **the OSM attribution**
  are re-drawn by hand in canvas — a second rendering of the same UI, which will drift from
  `hub.css` the first time someone restyles a legend and does not know the export exists.
- **OS window capture** (`xcap`, shared with landmine 6.3) is pixel-exact and permanently correct,
  and it makes map export depend on the **Screen Recording permission** — coupling a BI export
  feature to the most alarming permission macOS grants, in an app whose privacy posture is its
  pitch. A user who declines it loses map export, and the explanation is not one a user should have
  to hear.

Neither is wrong. Neither is free. **This is the decision Phase 6 should make first**, before any
Rust is written, because it determines whether the map export path is pure-JS (and therefore
testable in the existing harness) or native (and therefore not).

---

## 7. What to verify first — the cheapest experiments, in order

None of this needs Rust, and the first three need no Tauri.

1. **Canvas-area ceiling in WebKit.** In Safari on this Mac, allocate progressively larger canvases,
   `fillRect`, read one pixel back, find where it silently goes blank. Settles whether strip
   stitching is mandatory (§3.4) — and it is the risk most likely to be discovered late.
2. **`foreignObject` fidelity in WebKit.** Take `buildReportHtml`'s exact output, wrap it in an SVG
   `foreignObject`, rasterize, and diff against the current Electron PNG. Decides §3.4 (a) vs (b),
   and (b) is ~250 lines of work that (a) would avoid.
3. **JS map compositing.** Purely additive to today's code: extend `captureMapCanvasPNG` to draw the
   value labels via `map.project()`, plus the legend / note / attribution, and diff against the
   `capturePage` output **in the current Electron app**. If it matches now, it will match under
   Tauri, and the biggest unsolved problem (§6) is solved in JS with no permission cost.
4. **pdfmake `absolutePosition` for the dashboard grid.** Also doable in today's app: build a
   dashboard PDF through pdfmake instead of `printToPDF` and compare. Retires the `printToPDF`
   dependency before the shell port starts.
5. Only then, in Rust: the `sanitizeBundle` port + its differential test, and an `xcap` spike
   against a Tauri window containing a WebGL canvas.

Steps 1–4 are all reversible work inside the *current* Electron app, and every one of them makes
the Electron build simpler or more portable whether or not Phase 6 ever ships. That is the right
shape for work this far ahead of a landing.

---

## Appendix — measurements taken in this pass

`wc -l`: `src/dashboardExport.ts` 378 · `src/reportCapture.ts` 123 ·
`renderer/hub/reportExport.ts` 785 · `renderer/hub/mapRender.ts` 828 · `src/ipc/fileSave.ts` 129 ·
`src/ipc/dashboardExport.ts` 147 · `src/ipc/capture.ts` 54 · `src/ipc/clipboard.ts` 20 ·
`scripts/test-dashboardExport.ts` 127 (22 assertions) · `scripts/test-map-capture.ts` 37 (5
assertions).

`du -h` on `node_modules`: docx 1.1 M · pdfmake 1.0 M + fonts 836 K · pptxgenjs 452 K · chart.js UMD
204 K · maplibre-gl-csp 716 K + worker 344 K.

Bundle greps: 0 `new Worker` and 0 bare `eval(` in pdfmake and pptxgenjs; 1 `URL.createObjectURL` in
pptxgenjs; the three `new Function(` hits are all guarded `globalThis` / `setImmediate` shims that
already run under `script-src 'self'`.

crates.io API (live, this session) — the table in §2.10.

GitHub API (live, this session): tauri#12879 open since 2025-03-03, 1 comment · wry#707 open since
2022-09-29, 1 comment · tauri#12284 open since 2025-01-07, 0 comments · plugins-workspace#293 open
since 2023-03-31, 17 comments.

**Sources for the external claims:**
[wry #707 — silent print-to-PDF](https://github.com/tauri-apps/wry/issues/707) ·
[tauri #12879 — capturePage](https://github.com/tauri-apps/tauri/issues/12879) ·
[tauri #12284 — programmatic PDF](https://github.com/tauri-apps/tauri/issues/12284) ·
[plugins-workspace #293 — silent print plugin](https://github.com/tauri-apps/plugins-workspace/issues/293) ·
[WebView2Feedback #733 — CapturePreview is viewport-only](https://github.com/MicrosoftEdge/WebView2Feedback/issues/733) ·
[ICoreWebView2_7 (PrintToPdf)](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2_7) ·
[Apple Developer Forums — WKWebView offscreen rendering](https://developer.apple.com/forums/thread/710015) ·
[Apple Developer Forums — WKWebView doesn't snapshot WebGL](https://developer.apple.com/forums/thread/82368) ·
[wry macOS/WKWebView internals](https://deepwiki.com/tauri-apps/wry/3.2-macosios-(wkwebview)) ·
[Tauri v2 clipboard-manager](https://v2.tauri.app/reference/javascript/clipboard-manager/) ·
[Tauri v2 — calling Rust from the frontend (IPC payloads)](https://v2.tauri.app/develop/calling-rust/) ·
[xcap](https://crates.io/crates/xcap) · [docx-rs](https://crates.io/crates/docx-rs) ·
[ppt-rs](https://crates.io/crates/ppt-rs) · [printpdf](https://crates.io/crates/printpdf) ·
[typst](https://crates.io/crates/typst) · [image](https://crates.io/crates/image)
