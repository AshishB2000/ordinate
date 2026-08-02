# Phase 6 · 02 — Capture, the global hotkey, and the shell under Tauri

**Landmine 6.3.** Screen capture, `globalShortcut`, the selection overlay, the three remaining
windows, and the macOS Screen Recording permission that gates all of it.

**Status: RESEARCH ONLY. Nothing here was compiled or run.** Rust is not installed on this machine
and was deliberately not installed. Every statement below carries one of two labels:

- **[R]** — **RESEARCHED.** Read out of this repository's own source, or fetched from upstream
  documentation / source / issue trackers during this pass. The source is named.
- **[X]** — **REASONED.** An inference, a recollection, or a design proposal. Not confirmed against
  a source in this pass. Treat every **[X]** as a thing to verify before it is planned around.

No claim in this document is *verified*, in the sense this repo normally uses that word — nothing
was built, launched, or measured. `docs/phase-1/`-style measured tables have no counterpart here and
their absence is the point.

---

## 0. The headline, before the detail

Two things in the brief for this landmine are **wrong about the current code**, and both make the job
smaller than it looks:

1. **The overlay is not transparent.** `src/windows/overlayWindow.ts:14` sets
   `transparent: false`, and the comment above it says why: *"The dim is a CSS layer painted over an
   opaque frozen screenshot, so we do NOT need a transparent window (transparent + frameless is
   buggy across platforms)."* **[R]** This matters enormously. Transparency is the single Tauri
   feature on this path that carries a real, documented cost — on macOS it requires the
   `macos-private-api` feature flag, which bars the app from the Mac App Store **[R]**. Ordinate
   does not need it.
2. **The overlay is not click-through.** There is no `setIgnoreMouseEvents` anywhere in the repo.
   The overlay window swallows every event by design; that is how the drag works **[R]**.

And one thing the brief does not mention that is worth knowing up front: **there is no tray icon and
no application menu in this app.** `grep` for `Tray`, `setApplicationMenu`, `new Menu`, `app.dock`
across `main.ts`, `src/`, `preload/`, `renderer/`, `scripts/` returns nothing **[R]**. Electron's
implicit default menu is what users see today.

So the genuinely hard part of 6.3 is not the window. It is **the frozen frame and the permission
that produces it** — and the fact that `desktopCapturer` is being used in a very specific,
workaround-laden way that a Rust capture crate will not reproduce for free.

---

## 1. Inventory: what the capture path actually depends on

### 1.1 Electron APIs, by call site

| API | Call site | What it does here |
|---|---|---|
| `screen.getCursorScreenPoint()` | `src/capture.ts:97` | Cursor position in the global CSS-pixel desktop space |
| `screen.getDisplayNearestPoint(pt)` | `src/capture.ts:97` | **The display under the cursor** — the overlay target |
| `screen.getPrimaryDisplay()` | `src/capture.ts:88`, `src/windows/hubWindow.ts:62` | Unused for capture (`getPrimaryDisplay` is exported but the loop calls `getActiveDisplay`); the hub uses it to size itself |
| `screen.getDisplayMatching(bounds)` | `src/windows/hubWindow.ts:95` | Hub re-clamp on `moved` |
| `Display.bounds` / `.size` / `.scaleFactor` / `.workArea` / `.id` | `src/capture.ts:12-14,53,71-72`, `main.ts:184-186,220,225-226`, `hubWindow.ts:62-64,95` | Overlay geometry, capture resolution request, CSS↔device conversion, Dock-aware hub sizing |
| `desktopCapturer.getSources({types:['screen'], thumbnailSize})` | `src/capture.ts:23-29` | The frozen frame |
| `DesktopCapturerSource.display_id` | `src/capture.ts:51` | Match the returned source to the target display |
| `NativeImage.getSize()` | `src/capture.ts:66` | **Actual** device pixels of the returned bitmap |
| `NativeImage.crop()` | `src/capture.ts:83` | Crop the frozen frame to the selection |
| `NativeImage.isEmpty()` | `main.ts:194` | The real permission test (see §3) |
| `NativeImage.toDataURL()` | `main.ts:224`, `main.ts:389` | Frame → overlay; crop → hub/history/analyze |
| `systemPreferences.getMediaAccessStatus('screen')` | `main.ts:173` | **Advisory only** — logged, never acted on |
| `globalShortcut.register/unregister/isRegistered/unregisterAll` | `main.ts:496,503,511,654,666,669,694` | The hotkey |
| `app.commandLine.appendSwitch('disable-features', 'ScreenCaptureKit…')` | `main.ts:34-39` | macOS 14.4+ workaround |
| `app.commandLine.appendSwitch('password-store','basic')` | `main.ts:26` | Suppress a keychain prompt on unsigned dev builds |
| `app.requestSingleInstanceLock()` / `'second-instance'` | `main.ts:16`, `main.ts:49` | Two instances would contend for the hotkey |
| `app.whenReady` / `'will-quit'` / `'activate'` | `main.ts:631,693,702` | Lifecycle; `will-quit` calls `unregisterAll()` |
| `BrowserWindow` overlay options | `src/windows/overlayWindow.ts:11-33` | See §1.3 |
| `win.setAlwaysOnTop(true, 'screen-saver')` | `overlayWindow.ts:36` | Above the menu bar and fullscreen apps on macOS |
| `win.setVisibleOnAllWorkspaces(true)` | `overlayWindow.ts:37` | Spaces |
| `win.setBounds()` / `.show()` / `.focus()` | `main.ts:220-222` | Re-assert placement + steal focus after load |
| `webContents.once('did-finish-load')` / `on('did-fail-load')` | `main.ts:209,214` | Don't send the frame before the overlay can receive it |
| `webContents.capturePage(rect)` | `src/ipc/capture.ts:29` | Unrelated to screen capture — MapLibre map → PNG for reports |
| `shell.openExternal('x-apple.systempreferences:…Privacy_ScreenCapture')` | `src/ipc/shell.ts:29` | The permission panel's "Open Settings" button |

All **[R]** — read from this repo.

### 1.2 The loop, in order

`hotkey fires` (or `hub:capture`) → `config.executionReady()` gate → `startCapture()` →
advisory `getMediaAccessStatus` log → `getActiveDisplay()` → `captureFrozenFrame(display)` →
`frame.isEmpty()` check → `createOverlayWindow(display)` → `did-finish-load` →
`setBounds/show/focus` → send `overlay:frame` as a **data URL** → user drags → `capture:commit`
with a CSS-pixel rect → `cropToRect(frame, rect, display)` → `endCapture()` →
`cropped.toDataURL()` → history + `analyze()`. **[R]** (`main.ts:158-245`, `main.ts:380-443`.)

Three properties of this sequence are load-bearing and easy to lose in a port:

- **The frame is frozen *before* the overlay exists.** The overlay is painted *on top of* a picture
  of the screen taken a moment earlier. This is why the crop must come from the stored bitmap and
  **must not** be a second capture of the region — a re-capture would photograph the overlay's own
  dim layer. **[R]** (`src/capture.ts:56-84`; the crop reads `frozenFrame`, never re-captures.)
- **The rect crosses the IPC boundary in CSS pixels**, and the ratio used to convert it back to
  device pixels is derived from the **actual returned bitmap size** divided by the display's CSS
  size — *not* from `scaleFactor`. The comment at `src/capture.ts:62-64` says explicitly that
  platforms hand back a resolution other than the one requested. **[R]** That defensive design is
  exactly what a Rust port must preserve, because a capture crate's notion of "monitor width" may
  well be physical where Electron's is logical.
- **A click without a drag cancels.** Two independent guards: `r.w < 3 || r.h < 3` in the renderer
  (`renderer/overlay/overlay.ts:73`) and `w < 1 || h < 1` in the cropper (`src/capture.ts:80`). **[R]**

### 1.3 The overlay `BrowserWindow`, option by option

From `src/windows/overlayWindow.ts:12-37` **[R]**:

```
x/y/width/height = display.bounds   frame: false          transparent: false
alwaysOnTop: true                   skipTaskbar: true     resizable: false
movable: false                      minimizable: false    maximizable: false
fullscreenable: false               hasShadow: false      enableLargerThanScreen: true
setAlwaysOnTop(true, 'screen-saver')                      setVisibleOnAllWorkspaces(true)
```

Note what is *absent*: no `fullscreen: true`, no `kiosk: true` (the comment says avoiding them
"keeps show instant and Escape clean"), no `focusable: false`, no `transparent`. **[R]**

### 1.4 Multi-monitor and HiDPI, precisely

- Electron's `screen` module works in a single **CSS-pixel** coordinate space spanning all displays;
  a secondary monitor's `bounds.x/y` can be negative. The code comments this explicitly at
  `src/capture.ts:91-96`. **[R]**
- `thumbnailSize` is requested in **device** pixels (`width * scaleFactor`) — `src/capture.ts:26-27`.
  **[R]**
- The device-pixel ratio actually used for cropping is `actual.width / display.size.width`, recomputed
  per capture — `src/capture.ts:67-68`. **[R]**
- The overlay is positioned at `display.bounds` in CSS pixels and re-asserted after load because
  "the OS clamped it" is a real possibility the code logs for — `main.ts:202-220`. **[R]**

---

## 2. The Tauri equivalent for each piece

### 2.1 Summary table

| Electron | Tauri | Verdict |
|---|---|---|
| `globalShortcut` | `tauri-plugin-global-shortcut` | **Clean.** Accelerator strings parse verbatim (§2.2) |
| `screen.getCursorScreenPoint()` | `AppHandle::cursor_position()` | Exists; thread-safety caveat (§2.3) |
| `screen.getDisplayNearestPoint()` | `AppHandle::monitor_from_point(x, y)` | Exists (§2.3) |
| `screen.getPrimaryDisplay()` | `AppHandle::primary_monitor()` | **[X]** — assumed present, not fetched |
| `Display.workArea` (Dock-aware) | **No documented equivalent** | **Gap** (§2.3) |
| `desktopCapturer.getSources` | `xcap` crate (`Monitor::from_point` + `capture_image`) | Workable, but a different beast (§2.4) |
| `NativeImage.crop` | `image` crate (`DynamicImage::crop_imm`) | **[X]** trivial |
| `NativeImage.toDataURL` | manual base64 — or don't (§2.6) | Re-think, don't port |
| `systemPreferences.getMediaAccessStatus('screen')` | `CGPreflightScreenCaptureAccess` via `tauri-plugin-macos-permissions` or `core-graphics` | Available, and *better* than Electron's (§3) |
| overlay `BrowserWindow` options | `WebviewWindowBuilder` — 1:1 for everything Ordinate uses except one | Near-clean (§2.5) |
| `setAlwaysOnTop(_, 'screen-saver')` | `always_on_top(true)` only; higher level needs `ns_window()` + objc | **Partial gap** (§2.5) |
| `setVisibleOnAllWorkspaces(true)` | `visible_on_all_workspaces(true)` builder option | **Clean** |
| `did-finish-load` handshake | frontend-initiated `invoke('overlay_ready')` | **[X]** re-shape, don't port |
| `webContents.capturePage(rect)` (map→PNG) | **No equivalent** | **Genuine gap** (§2.7) |
| `requestSingleInstanceLock` | `tauri-plugin-single-instance` | **[X]** well-known plugin, not fetched |
| `app.on('activate')` | `RunEvent::Reopen` | **[X]** recalled, not fetched |
| `Notification` | `tauri-plugin-notification` | **[X]** out of this landmine's scope |
| Tray / app menu | `tray-icon` (`TrayIconBuilder`) / `muda` (`tauri::menu`) | **Clean, and both built in** (§5) |
| `app.commandLine.appendSwitch('disable-features', …)` | **Deleted** — Chromium-only workaround | Pure win (§2.4) |

### 2.2 The global hotkey — the cleanest item on the list

`tauri-plugin-global-shortcut` supports Windows, Linux and macOS (not mobile), registers via a Rust
`Result` (so failure is reportable) and exposes `unregister` / `unregister_all`. **[R]** — Tauri v2
plugin docs.

The important detail, and a genuinely lucky one: **Ordinate's stored accelerator strings parse
unchanged.** I read the parser in `tauri-apps/global-hotkey`'s `src/hotkey.rs` **[R]**:

- Modifier tokens are case-insensitive and include `COMMANDORCONTROL`, `COMMANDORCTRL`,
  `CMDORCTRL`, `CMDORCONTROL` (→ Super on macOS, Control elsewhere), plus `ALT`/`OPTION`,
  `CONTROL`/`CTRL`, `COMMAND`/`CMD`/`SUPER`, `SHIFT`.
- Key tokens accept both formal names (`KEYS`, `DIGIT1`, `F1`, `ARROWDOWN`) and bare symbols
  (`S`, `0`, `[`).

So `CommandOrControl+Alt+S` and `Control+Alt+S` — the two values `platformDefaultHotkey()` can
return (`src/hotkey.ts:7-9`) — both parse. **No config migration is needed for `config.hotkey`.** The
user's saved accelerator survives the shell swap byte-for-byte. **[R]** for the parser,
**[X]** for the conclusion (a full sweep of what users might have saved via `hotkey:save` was not
done — `hotkey:save` accepts any string the renderer sends and only validates by attempting
registration, `main.ts:489-513`, so a saved value outside this grammar is possible and would fail
loudly at startup rather than silently).

`src/hotkey.ts`'s other export, `hotkeyLabel()`, is pure `process.platform` string formatting **[R]**
— it moves to Rust or stays in JS unchanged; either is trivial.

**Mechanism, and the one behavioural risk.** `global-hotkey` on macOS uses Carbon
`RegisterEventHotKey`, which is the same API Electron's `globalShortcut` uses, and which
**does not require Accessibility permission** because it is narrowly scoped to one key combination.
**[R]** So the port adds no new permission prompt. But the same research surfaced a known limitation
of that API that applies equally to Electron today: **`RegisterEventHotKey` is not delivered when
certain self-drawing apps are frontmost** (Zed and VS Code are the cited cases), because those apps
consume the event first. **[R]** This is a pre-existing Ordinate bug, not a Tauri regression — worth
recording so nobody attributes it to the migration.

`will-quit → globalShortcut.unregisterAll()` (`main.ts:693-694`) maps to `unregister_all()` on
`RunEvent::Exit`. **[X]**

### 2.3 Monitors and the cursor

Tauri 2's `AppHandle` exposes `cursor_position()`, `available_monitors()`, `monitor_from_point(x, y)`,
and `Monitor` carries name, position, size and `scale_factor`. **[R]** — Tauri v2 JS/Rust API docs and
the `monitor_from_point` commit (`tauri-apps/tauri` ec0e092, PR #9770).

So `getActiveDisplay()` — the whole point of landmine 6.3's "the display under the cursor" — has a
direct two-call equivalent:

```rust
let p = app.cursor_position()?;                  // PhysicalPosition<f64>  [X] type recalled
let mon = app.monitor_from_point(p.x, p.y)?;     // Option<Monitor>
```

**Three caveats, in descending severity:**

1. **`cursor_position()` and `available_monitors()` are documented as not thread-safe.**
   `tauri-apps/tauri` issue **#15170** (opened 2026-03-28 against 2.10.3, still `needs triage`,
   PR #15630 open) reproduces segfaults and `malloc(): unaligned fastbin chunk` within 1–60 seconds
   when these are called concurrently from 20 threads. Reported on Windows and Linux. **[R]**
   Ordinate would call them from exactly one place, once per capture — but the capture is triggered
   from a **global-shortcut callback**, and whether that callback runs on the main thread is
   **[X] unverified**. If it does not, this must be wrapped in `run_on_main_thread`. **This is the
   single most concrete "go and check this first" item in the document.**
2. **Physical vs logical.** Tauri's `Monitor::position()`/`size()` are physical pixels **[X]**;
   Electron's `Display.bounds`/`size` are CSS pixels **[R]**. The overlay is *positioned* in logical
   units by `WebviewWindowBuilder::position()`/`inner_size()` (both documented as "logical pixels"
   **[R]**), so a port must divide by `scale_factor` on the way in. Getting this backwards produces
   an overlay that is correct on the built-in Retina display and wrong on every external monitor —
   the classic HiDPI bug, and one that will not reproduce on a single-display dev machine.
3. **`workArea` has no equivalent I could find.** Electron's `Display.workArea` already excludes the
   Dock and menu bar, and `hubWindow.ts` builds its whole sizing model on it (`fitToWorkArea`,
   `hubWindow.ts:47-56`) plus a `BOTTOM_MARGIN = 40` fudge because macOS under-reports **[R]**.
   Tauri's `Monitor` exposes size and position, not work area **[X]** — I found no `work_area()` in
   what I fetched. Recovering it means `NSScreen.visibleFrame` through `objc2`/`ns_window()`. This
   does **not** affect the overlay (which deliberately covers the *full* bounds including the menu
   bar) — only the hub's opening geometry. Losing it degrades to "hub opens slightly wrong size",
   which is cosmetic.

### 2.4 The frozen frame — `xcap`

**The named crate: `xcap`** (`nashaofu/xcap`, Apache-2.0, the successor to the `screenshots` crate).
**[R]** Its `Monitor` API is a startlingly good fit **[R]** (docs.rs):

| Ordinate needs | `xcap` gives |
|---|---|
| the display under the cursor | `Monitor::from_point(x, y) -> Result<Monitor>` |
| capture that whole display | `monitor.capture_image() -> Result<RgbaImage>` |
| crop to a rect | `image` crate — **or** `monitor.capture_region(x, y, w, h)` (**do not use**, see below) |
| identify the display | `id()`, `name()`, `friendly_name()`, `is_primary()` |
| geometry + DPR | `x()`, `y()`, `width()`, `height()`, `scale_factor()` |

**`capture_region` is a trap here.** It re-captures the screen. The overlay is on screen by the time
the rect is known, so a region re-capture would photograph the dim layer and the selection border.
The crop **must** come from the `RgbaImage` taken before the overlay opened. **[R]** for the ordering
constraint (this repo's own design), **[X]** for the claim that `capture_region` re-captures rather
than caching — inferred from the API shape, not read.

**Physical vs logical, again.** xcap's docs do "not explicitly address HiDPI scale factors or
physical versus logical pixels" **[R]** (DeepWiki's reading of the macOS implementation). Its macOS
monitor geometry comes from `CGDisplayBounds()` **[R]**, which returns *points*, not pixels, while
`CGDisplayCreateImage` returns a *pixel* buffer. That is precisely the mismatch
`src/capture.ts:66-68` already defends against by measuring the returned bitmap — **keep that
defence.** Do not replace `actual.width / display.size.width` with `scale_factor()`.

**What xcap uses on macOS: `CGDisplayCreateImage`, with `CGGetActiveDisplayList` for enumeration and
`CGDisplayBounds`/`CGDisplayRotation` for geometry.** **[R]** Two consequences:

- **`main.ts:34-39` deletes itself.** That switch
  (`disable-features=ScreenCaptureKitPickerScreen,ScreenCaptureKitStreamPickerSonoma,ThumbnailCapturerMac`)
  exists solely to force Chromium off ScreenCaptureKit and back onto the CG path because of
  electron#38190 **[R]**. xcap is *already* on the CG path. The workaround, and the Chromium version
  coupling it represents, go away. This is a real, if small, win for the migration's case.
- **`CGDisplayCreateImage` is deprecated as of macOS 14 (deprecated, not removed).** **[X]** —
  recalled, not fetched. Apple's direction is ScreenCaptureKit. So the workaround Ordinate removes
  today becomes a dependency question tomorrow: if xcap migrates to ScreenCaptureKit, Ordinate
  inherits whatever ScreenCaptureKit's permission behaviour is, with no `disable-features` escape
  hatch available (there is no Chromium to configure). **[X]** Flagged as a durability risk in §6.
- The alternative crate is **`scap`** (ScreenCaptureKit-based, aimed at streaming) **[R]** — named
  here only for completeness; it is a worse fit for a single frozen still.

**Dependency weight.** Not measured. `xcap` pulls `image`, `core-graphics`/`objc2`, and on Linux
`libxcb`/`libxrandr`/`dbus`/`pipewire`/`wayland` system packages **[R]**. **Linux Wayland is marked
⛔ not supported by xcap** **[R]** — Ordinate's Electron path already special-cases Wayland
(`isWayland()`, `main.ts:144-146`), and Linux is not a shipped target today, so this is a
documentation item rather than a blocker.

**Timeout behaviour.** `src/capture.ts:20-33` wraps `getSources` in a 10-second timeout because it
"can hang indefinitely in a packaged macOS app when Screen Recording permission isn't truly active"
**[R]**. Whether `CGDisplayCreateImage` can hang the same way is **[X] unknown**. Keep the timeout;
in Rust that means running the capture on a blocking task with a deadline rather than a `Promise.race`.

### 2.5 The overlay window

`WebviewWindowBuilder` documents `transparent`, `always_on_top`, `decorations`, `skip_taskbar`,
`focused`, `visible`, `visible_on_all_workspaces`, `shadow`, `position` (logical), `inner_size`
(logical), `fullscreen`, `resizable`, `closable`, `content_protected`. **[R]** — docs.rs.

Mapping Ordinate's twelve overlay options **[X]** for the mapping, **[R]** for each option's existence:

| Electron | Tauri | |
|---|---|---|
| `frame: false` | `decorations(false)` | ✅ |
| `transparent: false` | default | ✅ **and no `macosPrivateApi` needed** |
| `alwaysOnTop: true` | `always_on_top(true)` | ✅ |
| `skipTaskbar: true` | `skip_taskbar(true)` | ✅ |
| `resizable: false` | `resizable(false)` | ✅ |
| `hasShadow: false` | `shadow(false)` | ✅ |
| `setVisibleOnAllWorkspaces(true)` | `visible_on_all_workspaces(true)` | ✅ |
| `movable/minimizable/maximizable/fullscreenable: false` | no direct builder equivalents found for `movable`/`minimizable`/`maximizable` **[X]** | ⚠️ cosmetic — a frameless, `resizable(false)` window has no controls to press anyway |
| `enableLargerThanScreen: true` | none found **[X]** | ⚠️ macOS-only Electron safety valve; likely unnecessary since the overlay is exactly one display's bounds |
| `setAlwaysOnTop(true, 'screen-saver')` | **partial** — see below | ⚠️ **the one real gap** |

**The window-level gap.** Electron's second argument to `setAlwaysOnTop` selects an `NSWindow`
level; `'screen-saver'` is what puts the overlay above the menu bar and above other apps'
fullscreen windows. Tauri's `always_on_top(bool)` has **no level parameter and no documented
screen-saver/window-level option** **[R]** (docs.rs shows no such method). Community practice is to
reach through `window.ns_window()` and set the `NSWindow` level and
`NSWindowCollectionBehavior` (`FullScreenAuxiliary`, `Transient`, `IgnoresCycle`) directly via
objc **[R]** — tauri#11791, tauri#3326.

Practical read: **this is solvable but it is unsafe objc glue that must be written and, critically,
tested against (a) the menu bar, (b) another app in native fullscreen, (c) a second Space.** It is
the fiddliest twenty lines in the whole landmine, and it is exactly the kind of thing that is fine on
the developer's machine and broken on someone with three Spaces and Stage Manager. Also worth
recording: even native macOS cannot place a window above the actual screen saver since High Sierra
**[R]** — the level name is historical; what it buys is "above the menu bar", which is what Ordinate
needs.

**Does `renderer/overlay/` survive unchanged?** Very nearly, and this is the good news.

The renderer is 89 lines of `overlay.ts` **[R]**, and its entire contract with the outside world is
three calls on `window.overlay` (`preload/overlayPreload.ts`, 11 lines) — `onFrame(cb)`,
`commit(rect)`, `cancel()` **[R]**. Everything else is `mousedown`/`mousemove`/`mouseup`/`keydown`
against `window`, plus `element.style.left/top/width/height` **[R]**. All of that is plain DOM and
runs identically in WKWebView/WebKitGTK/WebView2. **[X]**

What has to change:

1. **The bridge.** `window.overlay.commit(...)` → `invoke('capture_commit', {...})`;
   `cancel()` → `invoke('capture_cancel')`; `onFrame(cb)` → `listen('overlay:frame', cb)`. Three
   lines of shim. The 89-line body need not be touched if the shim keeps the same three method
   names. **[X]**
2. **`onFrame` becomes a pull, not a push.** Today main waits for `did-finish-load` before sending
   (`main.ts:214-228`) **[R]**. Tauri has no clean `did-finish-load` **[X]**, so invert it: the
   overlay calls `invoke('overlay_ready')` on `DOMContentLoaded` and receives the frame in the
   response. This is *better* — it removes a race the current code papers over with a re-assert of
   `setBounds/show/focus`.
3. **How the frame gets there** — see §2.6. This is the only substantive change.
4. **`overlay.css` and `index.html` are untouched** **[X]**, with one caveat: the CSP. The overlay's
   `<meta>` CSP is `default-src 'none'; img-src data:; style-src 'self'; script-src 'self'` **[R]**.
   Tauri's CSP is configured **globally** at `app.security.csp` **[R]** — it is not per-window, which
   Ordinate currently is (hub, overlay and status each carry a different `<meta>`). Whether the
   per-window `<meta>` tags continue to work *in addition to* Tauri's injected policy is
   **[X] unverified**; if they do, the effective policy is the intersection and Ordinate keeps its
   tighter per-window posture. **This belongs to whoever owns the CSP document; noted here because
   `img-src data:` in the overlay is load-bearing for the frozen frame.**

**Zero shared globals** — confirmed: `renderer/overlay/globals.d.ts` declares only `window.overlay`
**[R]**. The overlay does not participate in the hub's 23-script shared scope, so it is portable
independently of whatever the hub/Svelte work decides.

### 2.6 Getting a full-screen bitmap into the overlay

This is the piece with no drop-in answer, and it is a *performance* problem rather than a
correctness one.

Today: `frozenFrame.toDataURL()` over IPC (`main.ts:224`) **[R]**. On a 5K display at 2× that is a
PNG of a full desktop, base64-encoded — comfortably several megabytes of string through a JSON
channel, twice (encode in main, decode in the webview). Electron survives it because both ends are
V8 in the same process tree and the string is passed structured-clone-ish.

Tauri's IPC is JSON over a custom protocol **[X]**, and a multi-megabyte base64 string in a JSON
payload is the documented worst case for it. Three options, in order of preference:

1. **Write the PNG to a temp file, load it via the asset protocol.** The app already writes crops to
   `userData/tmp/…` for the Local CLI image-delivery path (`CLAUDE.md`) **[R]**, so temp-file
   plumbing exists. Cost: the overlay CSP must gain `asset: http://asset.localhost` in `img-src`
   **[R]**, and `assetProtocol.scope` must be configured. **[R]**
2. **A custom URI scheme** (`register_uri_scheme_protocol`) serving the bitmap from memory —
   no disk write, no temp cleanup, and the CSP addition is one scheme instead of the general asset
   protocol. **[X]** My recommendation.
3. **Raw-bytes IPC response** (`tauri::ipc::Response::new(Vec<u8>)`) into a `Blob`/`createObjectURL`.
   **[X]** — I believe Tauri 2 supports raw response bodies, but did not confirm it in this pass.
   Would need `img-src blob:`.

Whichever is chosen, the CSS in `overlay.css` (`#frame { object-fit: fill; inset: 0 }`) does not
care **[R]** — it just needs an `<img src>`.

### 2.7 The one genuine hole: `capturePage`

`src/ipc/capture.ts` is misleadingly named. It has nothing to do with screen capture; it holds
`hub:captureRegion` (snapshot a rect of the *hub's own page*, for exporting the MapLibre WebGL map
plus its DOM overlays into reports) and `hub:captureReport` (offscreen HTML → PNG for dashboard
export) **[R]**. Both are `webContents.capturePage()` **[R]**.

The comment at `src/ipc/capture.ts:12-18` explains why this cannot be `canvas.toDataURL()`:
`capturePage` snapshots the **composited** page, so WebGL layers and DOM markers come back in one
image, and it does not require `preserveDrawingBuffer` **[R]**. `CLAUDE.md` states the same
constraint from the other direction: MapLibre has no `glyphs`, so value labels are DOM `Marker`s, and
*"a bare `canvas.toDataURL()` drops them, and export must composite via `capturePage`"* **[R]**.

**Tauri has no `capturePage`.** **[X]** — I found no equivalent and do not believe one exists;
WKWebView has `takeSnapshot(with:)` **[X]** which could be reached through `ns_window()`/objc, but
WebView2 and WebKitGTK would each need their own path, and the offscreen-window variant
(`hub:captureReport`, which renders an arbitrary-height one-pager in a *hidden* window) has no
obvious analogue at all.

**This is a cross-landmine problem** — it lands on map export, dashboard PNG export and dashboard PDF
export, not on the capture loop. It is flagged here because it lives in the file named
`src/ipc/capture.ts` and would otherwise fall between two agents. Whoever owns export needs to own
this.

---

## 3. The macOS permission story

### 3.1 What the app does today

Ordinate's handling is unusually sophisticated, and understanding *why* is the key to porting it.

- `systemPreferences.getMediaAccessStatus('screen')` is called and **logged, never acted on.** The
  comment (`main.ts:164-175`) is emphatic: it is *"ADVISORY ONLY… documented-unreliable: it caches a
  STALE 'denied' even after the user grants Screen Recording (electron#36722), while
  `desktopCapturer.getSources()` actually works. It also never prompts."* **[R]**
- **The real test is the captured frame.** `frozenFrame.isEmpty()` → open the permission panel
  (`main.ts:194-199`) **[R]**.
- **The prompt is a side effect.** On a `not-determined` state, calling `getSources()` is what makes
  macOS show its own dialog (`main.ts:171-173`) **[R]**. There is no explicit request API in play.
- The UI is `#permission-panel` inside the hub — a fixed overlay panel, not a window. Its
  "Open Settings" button invokes
  `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`
  (`src/ipc/shell.ts:26-31`, wired at `renderer/hub/hub.ts:2004-2012`) **[R]**.
- `NSScreenCaptureUsageDescription` is declared via `build.mac.extendInfo` in `package.json` **[R]**,
  and `scripts/afterPack.ts` strips **twelve** other usage-description keys Electron ships by default
  (camera, microphone, Bluetooth, audio capture, plus defensive Photos/Desktop/Documents/Downloads/
  Contacts/Location) so the declared privacy surface is exactly one key **[R]**.

### 3.2 The signing coupling — already understood, already painful

`docs/self-signed-signing.md` and `scripts/afterSign.ts` document the situation exactly **[R]**:

> macOS ties the **Screen Recording (TCC) permission** to an app's **code signature**. With ad-hoc
> signing (`identity: null`) every rebuild produces a *different* signature, so the grant never
> sticks. *(`docs/self-signed-signing.md`)*

`afterSign.ts` exists because electron-builder was shipping Electron's *generic linker signature*
(`Identifier=Electron`, adhoc, Info.plist not bound, `Sealed Resources=none`) — a weak identity macOS
would not hold a TCC grant against. The hook force re-signs the whole bundle ad-hoc with
`--identifier app.screenshot.desktop --options runtime --entitlements …`, then **fails the build**
if `codesign -dv` does not report that identifier, Info.plist bound, and sealed resources **[R]**.

**None of that is Electron-specific reasoning.** It is macOS TCC behaviour, and it applies to a Tauri
bundle identically. **[X]**

### 3.3 What changes under Tauri

**Detection — strictly better.** Two named options:

- **`tauri-plugin-macos-permissions`** (ayangweb, Tauri v2 only): check *and request* screen
  recording, accessibility, full disk access, microphone, camera, input monitoring. Its v2.3.0
  release note says it "removed the core-graphics dependency to implement screen recording
  permission." **[R]**
- **Direct `core-graphics`**: `CGPreflightScreenCaptureAccess()` / `CGRequestScreenCaptureAccess()`.
  xcap already calls `CGPreflightScreenCaptureAccess()` internally and warns when it returns false
  **[R]**, so the crate is in the dependency tree either way.

This is a genuine improvement over Electron. `CGPreflightScreenCaptureAccess` is the *actual* TCC
query; `getMediaAccessStatus('screen')` is Chromium's cached view of it, which is the thing
electron#36722 says goes stale **[R]**. And `CGRequestScreenCaptureAccess()` is an **explicit
prompt** — Ordinate currently has no way to ask, only to trigger the prompt as a side effect of
attempting a capture **[R]**.

**So the permission flow can become honest:**

```
hotkey → CGPreflightScreenCaptureAccess()
  true       → capture
  false, first run → CGRequestScreenCaptureAccess()   ← explicit, user sees the OS dialog
  false, previously denied → open #permission-panel (unchanged) → deep link to System Settings
```

Keeping the `frame.is_empty()` backstop costs nothing and should stay: preflight can still lie in
the direction that matters least (claiming access that a stale TCC row does not honour). **[X]**

**What the user sees change:**

1. **A cleaner first run.** Today the very first capture races the OS dialog and often fails, which
   is why the error path deliberately suppresses a "Capture failed" card and routes to the
   permission panel instead (`main.ts:235-243`) **[R]**. With an explicit `CGRequestScreenCaptureAccess`
   before the first capture, that race is designed out. **[X]**
2. **One more relaunch, possibly.** macOS commonly requires a relaunch after Screen Recording is
   granted **[X]**. This is unchanged from Electron, but the code's TODO at `main.ts:241-242`
   ("grant Screen Recording, then relaunch") suggests it is currently unhandled either way.
3. **The `x-apple.systempreferences:` deep link is shell-agnostic** — it is just `openExternal`, and
   Tauri's opener plugin does the same **[X]**. The permission panel's UI needs no change **[R]**
   (it is hub DOM, and it already never touches Electron directly — only `window.hub.openSystemSettings()`).

**Info.plist and entitlements — a straight port:**

| Today | Tauri |
|---|---|
| `build.mac.extendInfo.NSScreenCaptureUsageDescription` | `src-tauri/Info.plist`, merged into the generated one by the CLI **[R]** |
| `build/entitlements.mac.plist` | `bundle.macOS.entitlements` **[R]** |
| `build.mac.hardenedRuntime` | `bundle.macOS.hardenedRuntime` (defaults **true**) **[R]** |
| `identity: null` / `CSC_IDENTITY_AUTO_DISCOVERY=false` | `bundle.macOS.signingIdentity: "-"` (documented ad-hoc pseudo-identity) **[R]** |
| `build.mac.minimumSystemVersion: "11.0"` | `bundle.macOS.minimumSystemVersion` (default 10.13) **[R]** |
| notarization via `afterSign` (not used — build is unsigned in CI) | `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or `APPLE_API_KEY`/`APPLE_API_ISSUER`/`APPLE_API_KEY_PATH` **[R]** |

**The entitlements file itself mostly evaporates.** All four keys in `build/entitlements.mac.plist`
(`allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`,
`allow-dyld-environment-variables`) exist because **"Electron/V8 needs a writable+executable JIT
heap"** **[R]**. A Tauri app is a Rust binary plus the system WebView; `allow-jit` may still be
needed for JavaScriptCore in WKWebView **[X]**, but `allow-unsigned-executable-memory` and
`allow-dyld-environment-variables` almost certainly are not. **Do not copy the file across
blindly** — each key is a hardened-runtime relaxation, and shipping unneeded ones weakens the seal
that TCC is attached to.

**`afterPack.ts`'s twelve-key strip becomes unnecessary** — those keys are in *Electron's* stock
Info.plist. Tauri generates its own **[X]**, so the privacy surface should be one key by construction
rather than by subtraction. That is a small but real win: `afterPack.ts` currently shells out to
`/usr/libexec/PlistBuddy` twelve times per build **[R]**.

**`afterSign.ts`'s re-sign may or may not be needed.** It exists because *electron-builder* left a
generic linker signature behind. Whether `tauri build` produces a complete, identifier-bound,
resource-sealed signature under `signingIdentity: "-"` is **[X] unverified and must be checked with
`codesign -dv --verbose=4` on the first Tauri bundle.** The assertion logic in `afterSign.ts:44-58`
(identifier must equal the bundle id, Info.plist must be bound, sealed resources must not be `none`)
is the right acceptance test and should be ported to a CI check regardless of shell.

**`tauri-apps/tauri` issue #10567** reports exactly the symptom this repo already documents —
macOS permissions re-requested after a manually installed update, with the workaround being to
remove the old grant before re-granting. It was **closed as "not planned."** **[R]** Read plainly:
Tauri offers no help here, and the self-signed-certificate strategy in
`docs/self-signed-signing.md` remains the answer under either shell.

### 3.4 One thing that must not be lost: `disclaim-exec`

`native/disclaim-exec.c` + `src/disclaim.ts` solve a TCC problem adjacent to, but distinct from,
screen recording: when Ordinate spawns a Local CLI agent, **macOS walks up the process tree and
blames Ordinate for the agent's file access**, so testing a provider pops Photos / Desktop /
Documents / Downloads prompts under Ordinate's name. `detached: true` does not fix it. The fix is the
private `responsibility_spawnattrs_setdisclaim()` plus `POSIX_SPAWN_SETEXEC` — the same technique
VS Code and Qt Creator use. The helper is compiled universal in `afterPack.ts` and ad-hoc signed into
`Contents/Resources/`. **[R]**

This is **entirely shell-independent** — it is a C helper invoked via `posix_spawn`, and Rust can
prefix a command with it exactly as `wrapCommand()` does **[R]**. But it is easy to miss during a
port because it lives in an `afterPack` hook and a 34-line module, and losing it produces a bizarre,
hard-to-diagnose regression (unrelated permission prompts appearing under the app's name). Two
things must survive: the universal `clang -arch x86_64 -arch arm64` compile step must be re-homed
into the Tauri build (Tauri has no `afterPack`; `bundle.macOS.files` can place a prebuilt binary in
`Contents/` **[R]**, or a `build.rs` can compile it), and `helperPath()`'s `process.resourcesPath`
lookup becomes `app.path().resource_dir()` **[X]**.

---

## 4. The overlay window, assessed honestly

Ranking the overlay's requirements by how much trouble each will actually be:

| Requirement | Tauri | Trouble |
|---|---|---|
| Covers exactly one display, correct display | `position()`/`inner_size()` from `Monitor` **[R]** | **Low** — but see the logical/physical trap (§2.3) |
| Frameless | `decorations(false)` **[R]** | **None** |
| Opaque + CSS dim | default; no `macosPrivateApi` **[R]** | **None** — the brief's hardest item does not apply |
| Always on top | `always_on_top(true)` **[R]** | **None** |
| **Above the menu bar** | needs `ns_window()` + objc **[R]** | **Medium-high** — unsafe glue, and it is the difference between "usable" and "the menu bar shows through the dim" |
| Above other apps' fullscreen | `NSWindowCollectionBehaviorFullScreenAuxiliary` via objc **[R]** | **Medium-high** — same glue |
| All Spaces | `visible_on_all_workspaces(true)` **[R]** | **None** |
| Grabs focus immediately | `focused(true)` **[R]** + possibly `set_focus()` **[X]** | **Medium** — Electron needed `show()` *and* `focus()` after load even with `alwaysOnTop`, per the comment at `main.ts:217-219` **[R]**. Expect the same fight, without Electron's accumulated fixes. If focus is not grabbed, `keydown` never fires and **Escape stops cancelling** |
| Escape cancels | plain DOM `keydown` **[R]** | **None**, *given* focus |
| Drag select | plain DOM mouse events **[R]** | **None** |
| Click-through | **not required** — no `setIgnoreMouseEvents` in the repo **[R]** | n/a |
| Instant show | a fresh WebView per capture **[X]** | **Unknown, and the thing I would measure first.** Electron reuses a warm renderer process; WKWebView cold-start for an 89-line page is probably fine, but "probably" is doing work there, and the capture loop is a hotkey-to-pixels latency story |

**Verdict on `renderer/overlay/`: it survives.** 89 lines of DOM, three bridge calls, zero shared
globals, and a CSS file that only needs `img-src`. Rewrite the bridge shim, invert the frame
handshake, leave the body alone. **[X]** — reasoned from a full read of the file, not from a running
port.

---

## 5. The other windows, the tray, and the menu

### 5.1 Three windows, and one of them is nearly dead

| Window | Created where | Reality |
|---|---|---|
| **Hub** | `hubWindow.ts` — `hiddenInset` on macOS, `titleBarOverlay` (WCO) on Windows, work-area fitting, `moved` re-clamp **[R]** | The app. Everything of substance is here |
| **Overlay** | `overlayWindow.ts` — per capture, destroyed after **[R]** | §4 |
| **Status** | `statusWindow.ts` — 400×320, non-resizable **[R]** | **Effectively dead.** `ensureStatusWindow()` has exactly **one** caller: `pushStatus()`, and `pushStatus()` has exactly **one** call site — the overlay's `did-fail-load` handler at `main.ts:211` **[R]**. It is an error-path window for a failure mode that a Tauri port would restructure anyway |

**Recommendation: do not port the status window.** Its content (the hotkey label and a note) already
duplicates hub UI, and its only trigger is an overlay load failure that should be a hub banner.
Deleting it removes a window, a preload, a renderer, a CSS file and an IPC channel from the port's
surface area. **[X]** — a judgement call, flagged as such, and it belongs to whoever owns the
parity inventory.

**The hub's Tauri mapping** (not this landmine's, but adjacent to window creation):

| Electron | Tauri | |
|---|---|---|
| `titleBarStyle: 'hiddenInset'` | `title_bar_style(TitleBarStyle::Overlay)` **[X]** | Tauri 2 has a macOS title-bar style enum; exact variant unverified |
| `titleBarOverlay` (Windows WCO, repainted on theme change via `setHubTitleBarOverlay`) **[R]** | **No equivalent found** **[X]** | Windows-only cosmetic; likely becomes a custom CSS title bar |
| `backgroundColor` | `background_color()` **[X]** | |
| `minWidth`/`minHeight` | `min_inner_size()` **[R]** | |
| `moved` re-clamp | `WindowEvent::Moved` **[X]** | Depends on a `work_area()` equivalent (§2.3) — may simply be dropped |
| `contextIsolation: true, nodeIntegration: false` | **structurally guaranteed** — a Tauri webview has no Node **[X]** | The strongest single security argument for the migration |

### 5.2 Tray / status item

**There is no tray icon today.** **[R]** Nothing to port.

If one is wanted, Tauri 2 ships it in core: `TrayIconBuilder::new()` with `.menu()`, `.icon()`,
`.on_menu_event()`, and five click event types (Click / DoubleClick / Enter / Move / Leave) with
cursor-position data via `event.rect`. Menus show on both left and right click by default;
`show_menu_on_left_click(false)` restricts to right-click. Linux does not deliver the click events
though context menus still work. **[R]** — Tauri v2 system-tray docs. macOS specifics
(`icon_as_template` for a menu-bar-appropriate monochrome icon) were **not** covered by the page I
fetched **[R]**; I believe the option exists **[X]**.

Worth noting for scope discipline: a menu-bar app is arguably the *right* shape for a hotkey-driven
screenshot tool, and Tauri makes it cheap. It is also unambiguously a **new feature**, and CLAUDE.md's
"Don't build out-of-scope features unprompted" applies.

### 5.3 Application menu

**No `Menu.setApplicationMenu` call exists** **[R]** — the app runs on Electron's implicit default
menu (App / File / Edit / View / Window / Help, with Copy/Paste/Quit/Minimise wired up).

Tauri 2 has native menus built in (`tauri::menu`, backed by `muda`) and builds a default menu when
none is set **[X]**. The risk is not "no menu API" — it is that Tauri's default may differ from
Electron's, and **on macOS, losing the Edit menu silently disables ⌘C/⌘V/⌘A in the webview**, because
those are menu-driven on macOS rather than webview-native. **[X]** That would be an invisible,
infuriating regression in a data app full of text fields. **Explicitly construct the Edit submenu;
do not rely on the default.**

---

## 6. Risk-ranked

Ranked by (likelihood × cost to fix), highest first.

| # | Risk | Why | If it bites |
|---|---|---|---|
| 1 | **HiDPI / multi-monitor geometry is silently wrong** | Three coordinate systems now: Electron CSS px (gone), Tauri *logical* window px **[R]**, Tauri *physical* monitor px **[X]**, and xcap's `CGDisplayBounds` points vs `CGDisplayCreateImage` pixels **[R]**. Won't reproduce on a single Retina display | Fixable, tedious. Keep `src/capture.ts`'s measure-the-actual-bitmap discipline; test on an external non-Retina monitor with a negative-origin arrangement before believing anything |
| 2 | **The overlay does not float above the menu bar / fullscreen apps** | Tauri exposes no window level **[R]**; requires objc through `ns_window()` **[R]** | Fixable with unsafe glue. But it is unsafe glue in the hot path of the app's signature feature, on the one platform that is shipped |
| 3 | **`cursor_position()` thread-safety** | tauri#15170, open, `needs triage`, segfaults under concurrency **[R]**; the caller is a global-shortcut callback whose thread is **[X] unknown** | Cheap if caught (`run_on_main_thread`), brutal if not — an intermittent segfault on hotkey press |
| 4 | **`capturePage` has no equivalent** → map PNG export, dashboard PNG/PDF export | `webContents.capturePage` composites WebGL + DOM markers, which `canvas.toDataURL()` cannot **[R]**; the offscreen-window variant has no analogue at all **[X]** | **Possibly unfixable without abandoning part of the feature set.** Not the capture loop — but it is the largest genuinely-open question this landmine touches |
| 5 | **The overlay fails to grab focus → Escape stops working** | Electron needed `show()`+`focus()` after `did-finish-load` even with `alwaysOnTop` **[R]**; Tauri will have its own version of that fight without Electron's accumulated fixes | Fixable. Add a mouse-based cancel (right-click / click-without-drag already cancels **[R]**) as a belt-and-braces escape hatch |
| 6 | **`CGDisplayCreateImage` deprecation** | xcap is on the CG path **[R]**; Apple's direction is ScreenCaptureKit **[X]**. If xcap migrates, Ordinate inherits SCK's permission behaviour with no `disable-features` escape hatch — the very thing `main.ts:34-39` exists to provide today **[R]** | A future forced migration, not a today problem. But it removes an escape valve the app currently relies on |
| 7 | **Multi-megabyte frozen frame through IPC** | Base64 PNG of a 5K desktop in a JSON channel **[R]** for the current shape | Fixable — custom URI scheme (§2.6). Costs a CSP directive |
| 8 | **Entitlements copied across blindly** | Four hardened-runtime relaxations that exist for V8's JIT **[R]**, three of which a Rust+WKWebView app probably does not need **[X]** | Silent security regression, and a weaker seal for the TCC grant to attach to |
| 9 | **`disclaim-exec` quietly dropped** | Lives in an `afterPack` hook Tauri does not have **[R]** | Bizarre regression: unrelated Photos/Documents prompts under the app's name. Trivial to fix once diagnosed, hard to diagnose |
| 10 | **macOS Edit menu lost** | No explicit menu today **[R]**; Tauri's default may differ **[X]** | ⌘C/⌘V dead in a data app. Trivial fix, embarrassing bug |
| 11 | **`workArea` gap** → hub opens at a wrong size relative to the Dock | No `work_area()` found **[X]**; `fitToWorkArea` depends on it **[R]** | Cosmetic. Or `NSScreen.visibleFrame` via objc |
| 12 | **Wayland** | xcap: ⛔ **[R]** | Linux is not a target today **[R]**. Documentation only |

**What could not be fixed without abandoning Tauri:** honestly, **nothing on the capture path.**
Every item above has at least a plausible route, and several are strictly better than today. The one
item I would put in the "may have no answer" column is **#4, `capturePage`** — and it is not part of
capture. If dashboard PNG/PDF export and map export cannot be reproduced, that is a feature-set
decision, not a shell decision, and it should be settled before the port is committed to.

The honest counterweight is **#2 plus #5**: the overlay's *window behaviour* is the part with the
most unsafe-objc surface and the least documented support, and it is the part users notice
immediately. Electron gives Ordinate `setAlwaysOnTop(win, 'screen-saver')` — one call, tested by
thousands of apps. Tauri gives a `ns_window()` pointer and good luck. That is not a blocker; it is a
recurring maintenance tax, and it should be priced in rather than discovered.

---

## 7. Verdict and confidence

**Clean Tauri path** (would expect these to work close to first try):

- The **global hotkey** — plugin exists, same underlying Carbon API as Electron, **accelerator
  strings parse verbatim so no config migration** **[R]**
- **Cursor position + display-under-cursor** — `cursor_position()` + `monitor_from_point()` **[R]**
- **The frozen frame** — `xcap::Monitor::from_point(...).capture_image()` is almost suspiciously
  well-shaped for this exact job **[R]**
- **The overlay window's core options** — frameless, opaque, always-on-top, all-Spaces, no-shadow,
  positioned per display: all first-class builder options **[R]**, and **no `macosPrivateApi`**
  because the overlay is not transparent **[R]**
- **`renderer/overlay/`** — survives, minus a three-line bridge shim **[X]**
- **Permission detection** — `CGPreflightScreenCaptureAccess`/`CGRequestScreenCaptureAccess`, which
  is *more* honest than Electron's stale-cache `getMediaAccessStatus` **[R]**
- **Tray and menus** — built into Tauri 2, and there is nothing to port anyway **[R]**
- **Deletions**: the `disable-features` ScreenCaptureKit switch **[R]**, most of the entitlements
  file **[X]**, `afterPack`'s twelve-key Info.plist strip **[X]**, and the status window **[X]**

**Genuinely hard:**

- **The overlay's macOS window level** — above the menu bar and above fullscreen apps needs objc
  through `ns_window()`, and needs testing against Spaces, Stage Manager and native fullscreen **[R]**
- **HiDPI and multi-monitor coordinate conversion** — three unit systems, no compiler to catch the
  mistake, and a bug class that hides on a single-display dev machine
- **Getting a full-desktop bitmap into the webview** without a multi-megabyte JSON round trip **[X]**
- **Focus acquisition** for the overlay, on which Escape-to-cancel depends

**No answer found:**

- **`webContents.capturePage`** — for MapLibre map → PNG and for offscreen HTML → PNG report/dashboard
  export. Not the capture loop, but it lives in `src/ipc/capture.ts` and must not fall between agents
- **`Display.workArea`** — cosmetic, hub sizing only
- **Tauri per-window CSP** — Tauri's CSP is global **[R]**; Ordinate has three different per-window
  policies **[R]**. Whether `<meta>` CSP survives alongside it is unverified and belongs to the CSP
  document

### Confidence

**Moderate on the shape, low on the details, and the gap between those two is the honest answer.**

What I trust:

- The **inventory** (§1). It is read from this repository, line by line. High confidence.
- **Which APIs exist** on the Tauri side. Each was fetched from upstream docs, source, or an issue
  tracker in this pass, and is labelled. High confidence in existence; **no confidence at all in
  behaviour.**

What I do not trust, and why it matters:

1. **Nothing was compiled.** Not one line of Rust. Every code shape in this document is illustrative.
2. **Every hard problem in this landmine is a runtime problem.** Does the overlay actually float above
   the menu bar? Does it actually take focus? Is the frame actually the right size on an external
   1× display? Does the hotkey callback actually run on the main thread? **Documentation cannot
   answer any of those**, and they are exactly the questions that decide whether 6.3 takes a week or
   a month.
3. **The `[X]` labels are load-bearing.** In particular: Tauri monitor units (physical vs logical),
   `capture_region`'s re-capture semantics, `RunEvent::Reopen`, `title_bar_style` variants,
   raw-bytes IPC, and whether `tauri build` produces a TCC-durable signature. Each is a small
   assumption; several of them being wrong together would change the estimate materially.

**The single highest-value next step, the moment Rust exists on a machine:** a ~150-line throwaway
Tauri app that (a) registers `CommandOrControl+Alt+S`, (b) resolves the display under the cursor,
(c) captures it with xcap, (d) opens a frameless opaque window on exactly that display, (e) shows
the bitmap, (f) reports the drag rect back, and (g) is run **on a two-monitor setup with mismatched
scale factors, with the menu bar and a fullscreen app in the way.** That spike answers risks #1, #2,
#3, #5 and #7 — five of the top seven — in an afternoon, and it answers them with pixels rather than
prose. Everything in this document is a hypothesis until it runs.
