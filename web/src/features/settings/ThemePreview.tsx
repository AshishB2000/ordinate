// A theme drawn: the sample dashboard at thumbnail size (themeEditor.ts
// tePreview) and the list rows' four-bar thumbnail (themeSettings.ts teThumb).
// The figures are schematic placeholders, as in the desktop's Style panel —
// this shows a look, never data. Tokens go on as CSS custom properties through
// React's style object (the CSSOM — the CSP's style-src does not govern it).

import type { CSSProperties } from 'react';
import { isDark, themeCssVars, type Tokens } from './themeModel';
import t from './Themes.module.css';

function vars(tokens: Tokens): CSSProperties {
  const out: Record<string, string> = Object.fromEntries(themeCssVars(tokens));
  // Not a custom property: without it a dark theme draws light native controls.
  if (tokens['--bg']) out.colorScheme = isDark(tokens['--bg']) ? 'dark' : 'light';
  return out as CSSProperties;
}

const BAR_HEIGHTS = [55, 90, 40, 70];

export function ThemeThumb({ tokens }: { tokens: Tokens }) {
  return (
    <span className={t.thumb} style={vars(tokens)} aria-hidden="true">
      <span className={t.thumbCard}>
        {BAR_HEIGHTS.map((h, i) => (
          <span key={i} className={t.thumbBar} style={{ height: `${h}%`, background: `var(--chart-${i + 1})` }} />
        ))}
      </span>
    </span>
  );
}

const KPIS: Array<[string, string]> = [
  ['Revenue', '2.3M'],
  ['Profit', '286K'],
  ['Units sold', '38.7K'],
  ['Orders', '9,994'],
];
const LINES = ['4,38 16,30 28,33 40,22 52,26 64,15 76,19 88,9 100,12', '4,44 16,41 28,42 40,36 52,38 64,31 76,33 88,27 100,29'];
const BARS = [82, 64, 71, 45, 58, 37, 50, 28];

export function ThemePreview({ tokens }: { tokens: Tokens }) {
  return (
    <div className={t.sheet} style={vars(tokens)} role="img" aria-label="The sample dashboard drawn in this theme" data-testid="theme-preview">
      <div className={t.sheetTitle}>Retail sales</div>
      <div className={t.kpis}>
        {KPIS.map(([label, v]) => (
          <div key={label} className={t.card}>
            <div className={t.cardHead}>{label}</div>
            <div className={t.kpi}>
              <span className={t.kpiValue}>{v}</span>
              <span className={t.kpiLabel}>Sum of {label.toLowerCase()}</span>
            </div>
          </div>
        ))}
      </div>
      <div className={t.charts}>
        <div className={t.card}>
          <div className={t.cardHead}>Revenue by month</div>
          <svg className={t.line} viewBox="0 0 100 50" preserveAspectRatio="none">
            {LINES.map((pts, i) => (
              <polyline key={i} points={pts} style={{ stroke: `var(--chart-${i + 1})` }} />
            ))}
          </svg>
        </div>
        <div className={t.card}>
          <div className={t.cardHead}>Revenue by category</div>
          <div className={t.bars}>
            {BARS.map((h, i) => (
              <span key={i} style={{ height: `${h}%`, background: `var(--chart-${i + 1})` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
