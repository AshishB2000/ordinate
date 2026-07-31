# Self-signed code signing (macOS)

## Why

macOS ties the **Screen Recording (TCC) permission** to an app's **code signature**.
With ad-hoc signing (`identity: null`) every `electron-builder` rebuild produces a
*different* signature, so the grant never sticks — you allow Screen Recording, rebuild,
and the new binary reads `denied` again.

A **stable self-signed certificate** gives every rebuild the **same** signature, so the
TCC grant is attributed to the app reliably: grant it once → quit → relaunch (or even
rebuild with the same cert) → still granted → capture works.

## The tradeoff (important)

Self-signed is **stable** but **not notarized** and **not an Apple Developer ID**. So:

- ✅ Screen Recording permission **sticks** across rebuilds — capture works.
- ❌ Gatekeeper still shows **“Apple could not verify ‘Screenchart’ is free of malware.”**
  Users must **right-click → Open** (or System Settings → Privacy & Security → *Open Anyway*)
  the first time. This is expected and documented on the download page.

No paid Apple account, no notarization, no `Developer ID` — just a stable signature.

## One-time setup (per machine)

### Option A — script (recommended)

```bash
bash scripts/make-signing-cert.sh
```

Creates a self-signed **“Screenchart Code Signing”** certificate, imports it into your
login keychain, trusts it for code signing, and verifies it. Idempotent — safe to re-run
(it won't create a second cert).

### Option B — Keychain Access GUI

1. Open **Keychain Access** → menu **Certificate Assistant → Create a Certificate…**
2. **Name:** `Screenchart Code Signing`
3. **Identity Type:** `Self Signed Root`
4. **Certificate Type:** `Code Signing`
5. Create. It lands in your **login** keychain with its private key.

Verify either way:

```bash
security find-identity -v -p codesigning   # should list "Screenchart Code Signing"
```

The name **must exactly match** `build.mac.identity` in `package.json`.

## Build

```bash
npm run dist:mac          # signs with "Screenchart Code Signing"
```

- If macOS prompts to let `codesign` use the key on the first build, click **Always Allow**.
- `build.mac.gatekeeperAssess: false` lets the build finish despite the (expected)
  Gatekeeper rejection of a non-notarized app.
- `hardenedRuntime` stays **`false`** — not needed for self-signed, and the `afterPack`
  Info.plist strip (screen-recording-only privacy surface) is unaffected (it runs before
  signing).

**Unsigned / ad-hoc build** (CI, or a machine without the cert):

```bash
npm run dist:mac:unsigned   # CSC_IDENTITY_AUTO_DISCOVERY=false → skips signing
```

CI (`.github/workflows/build.yml`) already sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, so the
release build stays unsigned without needing the cert.

## Verify the signature is stable

```bash
codesign -dvvv "dist/mac-universal/Screenchart.app" 2>&1 | grep -E 'Authority|Identifier'
```

Two builds from the same cert should show the **same Authority** (`Screenchart Code Signing`)
and identifier — that stable identity is what makes TCC remember the grant.

## Test that the permission sticks

1. `bash scripts/make-signing-cert.sh` (once), then `npm run dist:mac`.
2. Install the DMG, move **Screenchart.app to /Applications**.
3. (Clean slate, optional) `tccutil reset ScreenCapture app.screenshot.desktop`.
4. **Double-click from /Applications.** First capture → macOS prompts for Screen Recording
   (status was `not-determined`) → **Allow**.
5. **Quit and relaunch.** Capture again → still granted, no re-prompt → works.
6. Rebuild with the **same** cert, reinstall → still granted (stable signature).
