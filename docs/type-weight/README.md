# Type weight — before / after

Real app (Electron under xvfb), 1440x900, splash waited out and removed. All six
sections were captured; Home, Data and Analyses are kept here because they are
the ones the PR argues from.

## Measured, per section (heading weight/size -> plain .btn -> .btn-primary)

| section | before | after |
| --- | --- | --- |
| Home | **700/30px** · — · 600/13.5 | **600/18px** · — · 600/13.5 |
| Explore | 600/27px · **600**/12.5 · — | 600/27px · **500**/12.5 · — |
| Data | 600/16px · **600**/12.5 · — | 600/16px · **500**/12.5 · — |
| Visuals | 600/18px · **600**/14.5 · 600/13.5 | 600/18px · **500**/14.5 · 600/13.5 |
| Analyses | 600/18px · **600**/13.5 · 600/13.5 | 600/18px · **500**/13.5 · 600/13.5 |
| Dashboards | 600/18px · — · 600/13.5 | 600/18px · — · 600/13.5 |

Before, every heading AND every button was weight 600 — that is the whole defect.

## Does 500 vs 600 actually render as a difference?

Yes. Measuring advance width of "Create analysis" at 13.5px in the app's own
resolved UI font:

| weight | width |
| --- | --- |
| 400 | 103.81px |
| 500 | 103.81px |
| 600 | 117.10px |
| 700 | 117.10px |

Two real faces, so 500 lands on the regular face and 600 on the semibold —
a ~13% advance-width difference, visible in `toolbar-before.png` vs
`toolbar-after.png`. It is a weight difference, not only a colour change.

The same table shows 550 and 650 were never distinct from 500 and 600, and 700
was never distinct from 600 — see the PR body.
