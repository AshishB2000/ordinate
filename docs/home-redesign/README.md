# Home redesign — before / after

Screenshots of the REAL app (Electron under xvfb) at 1440x900, on a throwaway
`--user-data-dir`, taken after the 3s splash was waited out and removed. Both
states are shown because Home has two that matter: what a user sees on day one,
and what they see once they have work.

| | before | after |
| --- | --- | --- |
| empty (first run) | `before-empty.png` | `after-empty.png` |
| populated | `before-populated.png` | `after-populated.png` |
| populated, dark | — | `after-populated-dark.png` |

## What was measured, not asserted

`document.querySelectorAll('.hub-body *')`, lowest `getBoundingClientRect().bottom`:

| state | before | after |
| --- | --- | --- |
| empty | content stopped at **655px** of 900 — 245px of dead white | **900/900**, the Recent panel reaches the bottom |
| populated | 655px | content runs past the fold, page scrolls |

The populated "after" seeds two projects, three datasets, two analyses and two
dashboards through the real main-process modules, so every row's second line is
computed from real records: `318 rows x 2 columns`, `3 sheets`, `7 tiles - 2 pages`.

## Reproducing

There is no committed harness for this — it is a one-off design record, not a
test. `npm run smoke` is what guards Home's behaviour (it asserts the Connect
shortcuts, the real capture hotkey, and fails on any renderer console error).
