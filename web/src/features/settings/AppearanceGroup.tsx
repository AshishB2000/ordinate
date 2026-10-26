// Settings → You → Appearance: the theme, the canvas (the neutral ramp every
// page sits on) and the highlight (the member's own accent). All three are kept
// in this browser (src/app/theme.ts) and applied to <html> before first paint
// by theme-boot.js. Each canvas chip draws its canvas in place: appearance.css
// matches the chip's own data-canvas, so the preview IS the preset.

import type { CSSProperties } from 'react';
import { CANVASES, HIGHLIGHTS, THEME_PREFS, useAccentPref, useCanvasPref, useThemePref, type ThemePref } from '../../app/theme';
import { Button } from '../../ui/Button';
import { Group, Row, Segmented } from './Rows';
import a from './Appearance.module.css';
import s from './Settings.module.css';

const THEME_LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export function AppearanceGroup() {
  const [theme, setTheme] = useThemePref();
  const [canvas, setCanvas] = useCanvasPref();
  const [accent, setAccent] = useAccentPref();
  return (
    <Group title="Appearance" desc="Kept in this browser, like the system setting it can follow.">
      <Row title="Theme" desc="Follow the system, or always light or dark.">
        <Segmented label="Theme" value={theme} onChange={setTheme} options={THEME_PREFS.map((p) => ({ value: p, label: THEME_LABEL[p] }))} />
      </Row>
      <Row stack title="Canvas" desc="The background, surfaces and text tones of every page, in light and dark.">
        <div className={a.canvases} role="radiogroup" aria-label="Canvas">
          {CANVASES.map((c) => (
            <button key={c.id} type="button" role="radio" aria-checked={c.id === canvas} className={a.canvas} onClick={() => setCanvas(c.id)}>
              <span className={a.preview} data-canvas={c.id} aria-hidden="true">
                <span className={a.panel}>
                  <span className={a.title} />
                  <span className={a.line} />
                  <span className={a.pill} />
                </span>
              </span>
              <span className={a.name}>{c.label}</span>
            </button>
          ))}
        </div>
      </Row>
      <Row
        stack
        title="Highlight"
        desc={
          accent
            ? 'Buttons, selections, focus and the small pictures on Home. Contrast is kept on every canvas.'
            : "Buttons, selections, focus and the small pictures on Home. Until you pick one, your organization's accent is used."
        }
      >
        <div className={s.swatches} role="radiogroup" aria-label="Highlight">
          {HIGHLIGHTS.map((h) => (
            <button
              key={h.id}
              type="button"
              role="radio"
              aria-checked={h.id === accent}
              aria-label={h.label}
              title={h.label}
              className={h.hex ? s.swatch : `${s.swatch} ${a.mono}`}
              style={h.hex ? ({ '--sw': h.hex } as CSSProperties) : undefined}
              onClick={() => setAccent(h.id)}
            />
          ))}
        </div>
        {accent && (
          <Button size="sm" variant="ghost" onClick={() => setAccent(null)}>
            Reset to default
          </Button>
        )}
      </Row>
    </Group>
  );
}
