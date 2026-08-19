# Capture page — AI selector top-right, simplified footer

Real app (Electron under xvfb), 1440x900, splash waited out and removed.

| file | what it shows |
| --- | --- |
| `before-capture.png` / `after-capture.png` | the capture page: selector added top-right, footer reduced to Settings |
| `after-capture-menu-open.png` | the selector's menu opened FROM the capture page — downward, fully on screen |
| `after-sidebar-menu-open.png` | the same menu from the sidebar button — upward, unchanged |
| `after-capture-settings-open.png` | the settings menu from the capture footer, with the folded Help rows |
| `after-home.png` / `after-data.png` | neither new control appears outside the capture page |

## Exactly one of each pair is ever visible

Measured `offsetParent !== null` in four states, before and after:

| state | #exec-mode-btn | #exec-mode-btn-cap | #settings-gear | #settings-gear-cap |
| --- | --- | --- | --- | --- |
| Home | yes | no | yes | no |
| Data | yes | no | yes | no |
| Capture (cap-focus) | no | **yes** | no | **yes** |
| sources, no cap-focus | yes | no | yes | no |

The last row is why the CSS gate matters: the `sources` section renders the same
legacy surface WITHOUT `cap-focus` (a capture fired from the hotkey lands there)
and the app sidebar is present at the same time. Without the `body.cap-focus`
rules both buttons of each pair would be on screen together.

## The menu opens the right way from both anchors

One positioning branch, no second path:

| opened from | top | bottom | viewport | direction |
| --- | --- | --- | --- | --- |
| capture top bar | 92 | 687 | 900 | downward |
| app sidebar | 256 | 850 | 900 | upward |

## Both buttons stay in sync

Driving the state `execActiveConnected()` reads, changing the active agent while
the sidebar button is HIDDEN:

| moment | #exec-mode-btn-cap | #exec-mode-btn |
| --- | --- | --- |
| on Home | Claude Code (hidden) | Claude Code (visible) |
| on Capture, agent switched | Codex CLI (visible) | Codex CLI (**hidden, still updated**) |
| after Back | Codex CLI (hidden) | Codex CLI (visible, **not stale**) |
