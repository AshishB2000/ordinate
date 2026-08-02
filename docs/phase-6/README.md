# Phase 6 — costing the Tauri shell

**Verdict: closed.** Not deferred — closed. The reasoning is in
[`04-process-model-and-verdict.md`](04-process-model-and-verdict.md) §7, and §7.3 states what would
reopen it, so the decision is falsifiable rather than a matter of taste.

| | |
|---|---|
| [`02-capture-and-shell.md`](02-capture-and-shell.md) | capture loop, hotkey, overlay, window model |
| [`03-export-stack.md`](03-export-stack.md) | PDF/Word/PPT/HTML export and offscreen rendering |
| [`04-process-model-and-verdict.md`](04-process-model-and-verdict.md) | process model, security, IPC, config/secrets, Local CLI, size, **verdict** |

**There is no `01`.** The session that produced this set stopped after writing 02–04 and the
numbering was never closed up. Nothing in 02–04 references a phase-6 `01` (the `01-toolchain.md`
citations point at [`docs/phase-5/`](../phase-5/)), so the set is complete in substance — but if a
scope/overview document was intended, it does not exist.

These documents are **analysis, not code**. Phase 6 changed no source file, which is the correct
shape for a phase whose question was "should we do this at all".

---

## Correction to §7.2 item 1 — the "112 MiB duplicate" is not in the shipped artifact

`04` §7.1 finding 1 and §7.2 item 1 rest on a MEASURED claim: that **112 MiB of a second
architecture's `libduckdb.dylib` ships inside the arm64 DMG**, making a packaging fix — not a
rewrite — the largest size win available.

The duplication is real, but it is **not in anything this project ships**. Re-measured:

| | |
|---|---|
| Configured mac target | `dmg` / **`universal` only** (`package.json` → `build.mac.target`) |
| `dist/latest-mac.yml` | lists **one** file: `Screenchart-0.1.0-universal.dmg` |
| Universal app | **one** `libduckdb.dylib`, 113 MB, `lipo -archs` → `x86_64 arm64` |
| `Screenchart-0.1.0-arm64.dmg` | dated **Aug 1 15:37** — a stale leftover from a build config that no longer exists. The universal DMG is Aug 2 00:02. |

The two-dylib tree the document measured is `dist/mac-arm64/`, an **intermediate** of the universal
build. `predist:mac` force-installs the x64 binding so `@electron/universal` has both slices;
`files: ["**/*"]` sweeps both into each per-arch pack; then the merger collapses them into the
single fat dylib above. The intermediate is not distributed.

**§7.2 item 3 was right to be suspicious of the artifact — more right than it knew.** It flagged
that the measured DMG predated the MapLibre swap; in fact that DMG predated a *build-configuration
change* as well.

### The recommendation survives; the mechanism changes

A universal DMG makes **every** user download **both** architectures — so an Apple-silicon user
still pays ~112 MiB for x86-64 code that can never execute on their machine. That is the same waste
the document identified, arriving by a different route, and it is still the cheapest large win
available. It just is not a bug to be fixed; it is a distribution choice to be revisited.

Splitting into per-arch DMGs is tracked separately from this document set, because doing it exposes
the duplication for real: once each architecture ships its own DMG, the per-pack tree the merger
used to clean up becomes the shipped tree, and the foreign-arch binding has to be stripped
deliberately.

Everything else in §7 — the security analysis, the Local CLI shell-plugin problem, and the
verification-story argument — is unaffected by this correction, and finding 4 (*a port that starts
by deleting the measuring apparatus is a bad trade regardless of the destination*) stands on its
own.
