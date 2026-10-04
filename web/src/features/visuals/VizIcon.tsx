// The chart-type glyphs (renderer/hub/renderResult.ts VIZ_ICONS): one mark per
// chart id, 16px at stroke 1.5 like the UI icon set. A chart TAXONOMY, not UI
// actions, so they live with the Visuals screen rather than in ui/icons.
// Generated from the legacy strings by a one-off script; edit by hand now.

import type { ReactNode } from 'react';

const GLYPHS: Record<string, ReactNode> = {
  column: (
    <>
      <rect x="4" y="11" width="4" height="9" fill="currentColor"/>
      <rect x="10" y="7" width="4" height="13" fill="currentColor"/>
      <rect x="16" y="13" width="4" height="7" fill="currentColor"/>
    </>
  ),
  bar: (
    <>
      <rect x="4" y="5" width="9" height="4" fill="currentColor"/>
      <rect x="4" y="11" width="14" height="4" fill="currentColor"/>
      <rect x="4" y="17" width="6" height="4" fill="currentColor"/>
    </>
  ),
  clustered_column: (
    <>
      <rect x="4" y="10" width="2.6" height="10" fill="currentColor"/>
      <rect x="7.2" y="7" width="2.6" height="13" fill="currentColor"/>
      <rect x="14" y="12" width="2.6" height="8" fill="currentColor"/>
      <rect x="17.2" y="9" width="2.6" height="11" fill="currentColor"/>
    </>
  ),
  clustered_bar: (
    <>
      <rect x="4" y="5" width="10" height="2.6" fill="currentColor"/>
      <rect x="4" y="8.2" width="13" height="2.6" fill="currentColor"/>
      <rect x="4" y="14" width="7" height="2.6" fill="currentColor"/>
      <rect x="4" y="17.2" width="11" height="2.6" fill="currentColor"/>
    </>
  ),
  stacked_column: (
    <>
      <rect x="6" y="5" width="5" height="15" rx="0.5"/>
      <line x1="6" y1="12" x2="11" y2="12"/>
      <rect x="14" y="9" width="5" height="11" rx="0.5"/>
      <line x1="14" y1="14" x2="19" y2="14"/>
    </>
  ),
  stacked_bar: (
    <>
      <rect x="4" y="6" width="15" height="5" rx="0.5"/>
      <line x1="11" y1="6" x2="11" y2="11"/>
      <rect x="4" y="14" width="11" height="5" rx="0.5"/>
      <line x1="9" y1="14" x2="9" y2="19"/>
    </>
  ),
  pct_stacked_column: (
    <>
      <rect x="6" y="4" width="5" height="16" rx="0.5"/>
      <line x1="6" y1="10" x2="11" y2="10"/>
      <rect x="14" y="4" width="5" height="16" rx="0.5"/>
      <line x1="14" y1="13" x2="19" y2="13"/>
    </>
  ),
  pct_stacked_bar: (
    <>
      <rect x="4" y="6" width="16" height="5" rx="0.5"/>
      <line x1="12" y1="6" x2="12" y2="11"/>
      <rect x="4" y="14" width="16" height="5" rx="0.5"/>
      <line x1="9" y1="14" x2="9" y2="19"/>
    </>
  ),
  line: (
    <>
      <polyline points="3 17 9 11 13 14 21 6"/>
    </>
  ),
  line_markers: (
    <>
      <polyline points="3 17 9 11 13 14 21 6"/>
      <circle cx="3" cy="17" r="1.6" fill="currentColor"/>
      <circle cx="9" cy="11" r="1.6" fill="currentColor"/>
      <circle cx="13" cy="14" r="1.6" fill="currentColor"/>
      <circle cx="21" cy="6" r="1.6" fill="currentColor"/>
    </>
  ),
  area: (
    <>
      <path d="M3 17l6-5 4 2 8-7v15H3z" fill="currentColor"/>
    </>
  ),
  stacked_area: (
    <>
      <path d="M3 18l6-3 4 2 8-4v7H3z" fill="currentColor"/>
      <path d="M3 12l6-4 4 2 8-5v6l-8 4-4-2-6 3z" fill="currentColor" opacity="0.5"/>
    </>
  ),
  pie: (
    <>
      <circle cx="12" cy="12" r="8"/>
      <path d="M12 12V4"/>
      <path d="M12 12l7 3.5"/>
    </>
  ),
  donut: (
    <>
      <circle cx="12" cy="12" r="8"/>
      <circle cx="12" cy="12" r="3.4"/>
    </>
  ),
  gauge: (
    <>
      <path d="M4 16a8 8 0 0 1 16 0"/>
      <path d="M12 16l4-4"/>
    </>
  ),
  scatter: (
    <>
      <path d="M4 4v16h16"/>
      <circle cx="9" cy="14" r="1.5" fill="currentColor"/>
      <circle cx="13" cy="9" r="1.5" fill="currentColor"/>
      <circle cx="17" cy="13" r="1.5" fill="currentColor"/>
      <circle cx="11" cy="16" r="1.5" fill="currentColor"/>
    </>
  ),
  bubble: (
    <>
      <path d="M4 4v16h16"/>
      <circle cx="9" cy="14" r="2.4"/>
      <circle cx="15.5" cy="9" r="3.2"/>
      <circle cx="18" cy="15.5" r="1.6"/>
    </>
  ),
  combo: (
    <>
      <rect x="5" y="12" width="3" height="8" fill="currentColor"/>
      <rect x="11" y="9" width="3" height="11" fill="currentColor"/>
      <rect x="17" y="13" width="3" height="7" fill="currentColor"/>
      <path d="M5 9l6-3 6 4"/>
    </>
  ),
  treemap: (
    <>
      <rect x="4" y="4" width="10" height="10" rx="0.5"/>
      <rect x="15" y="4" width="5" height="6" rx="0.5"/>
      <rect x="15" y="11" width="5" height="9" rx="0.5"/>
      <rect x="4" y="15" width="10" height="5" rx="0.5"/>
    </>
  ),
  heatmap: (
    <>
      <rect x="4" y="4" width="5" height="5"/>
      <rect x="10" y="4" width="5" height="5" fill="currentColor"/>
      <rect x="16" y="4" width="4" height="5"/>
      <rect x="4" y="10" width="5" height="5" fill="currentColor"/>
      <rect x="10" y="10" width="5" height="5"/>
      <rect x="16" y="10" width="4" height="5" fill="currentColor"/>
      <rect x="4" y="16" width="5" height="4"/>
      <rect x="10" y="16" width="5" height="4" fill="currentColor"/>
      <rect x="16" y="16" width="4" height="4"/>
    </>
  ),
  funnel: (
    <>
      <path d="M4 5h16l-3 5H7z" fill="currentColor"/>
      <path d="M7 12h10l-2 4H9z" fill="currentColor"/>
      <path d="M9.5 18h5l-1 2h-3z" fill="currentColor"/>
    </>
  ),
  histogram: (
    <>
      <path d="M4 4v16h16"/>
      <rect x="4.5" y="14" width="3.6" height="6" fill="currentColor"/>
      <rect x="8.2" y="10" width="3.6" height="10" fill="currentColor"/>
      <rect x="11.9" y="7" width="3.6" height="13" fill="currentColor"/>
      <rect x="15.6" y="11" width="3.6" height="9" fill="currentColor"/>
    </>
  ),
  sankey: (
    <>
      <rect x="3" y="5" width="2.4" height="6" fill="currentColor"/>
      <rect x="3" y="13" width="2.4" height="6" fill="currentColor"/>
      <rect x="18.6" y="8" width="2.4" height="8" fill="currentColor"/>
      <path d="M5.4 8c6 0 7 4 13 4"/>
      <path d="M5.4 16c6 0 7-4 13-4"/>
    </>
  ),
  candlestick: (
    <>
      <line x1="8" y1="4" x2="8" y2="20"/>
      <rect x="6" y="8" width="4" height="7" fill="currentColor"/>
      <line x1="16" y1="6" x2="16" y2="21"/>
      <rect x="14" y="10" width="4" height="6"/>
    </>
  ),
  boxplot: (
    <>
      <line x1="7" y1="4" x2="7" y2="20"/>
      <rect x="4" y="9" width="6" height="7"/>
      <line x1="4" y1="12.5" x2="10" y2="12.5"/>
      <line x1="16" y1="6" x2="16" y2="20"/>
      <rect x="13" y="10" width="6" height="6"/>
      <line x1="13" y1="13" x2="19" y2="13"/>
    </>
  ),
  waterfall: (
    <>
      <rect x="3" y="12" width="3.6" height="8" fill="currentColor"/>
      <rect x="8" y="6" width="3.6" height="6" fill="currentColor"/>
      <rect x="13" y="6" width="3.6" height="4"/>
      <rect x="18" y="10" width="3.4" height="10" fill="currentColor"/>
      <path d="M6.6 12H8M11.6 6H13M16.6 10H18"/>
    </>
  ),
  bullet: (
    <>
      <rect x="3" y="4.5" width="18" height="6" fill="currentColor" opacity="0.3" stroke="none"/>
      <rect x="3" y="6.5" width="11" height="2" fill="currentColor" stroke="none"/>
      <line x1="16.5" y1="3.5" x2="16.5" y2="11.5"/>
      <rect x="3" y="13.5" width="18" height="6" fill="currentColor" opacity="0.3" stroke="none"/>
      <rect x="3" y="15.5" width="15" height="2" fill="currentColor" stroke="none"/>
      <line x1="13" y1="12.5" x2="13" y2="20.5"/>
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/>
      <rect x="3" y="9.2" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none"/>
      <rect x="3" y="14.4" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/>
      <rect x="8.2" y="4" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none"/>
      <rect x="8.2" y="9.2" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/>
      <rect x="8.2" y="14.4" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none"/>
      <rect x="13.4" y="4" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/>
      <rect x="13.4" y="9.2" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none"/>
      <rect x="13.4" y="14.4" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/>
      <rect x="18.6" y="4" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none"/>
      <rect x="18.6" y="9.2" width="3.6" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" stroke="none"/>
    </>
  ),
  radar: (
    <>
      <path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z"/>
      <path d="M12 7.5l4.6 3.1-1.4 5.4H9.4l-2.6-5z" fill="currentColor" opacity="0.45"/>
    </>
  ),
  pareto: (
    <>
      <rect x="4" y="9" width="3.4" height="11" fill="currentColor" stroke="none"/>
      <rect x="8.6" y="13" width="3.4" height="7" fill="currentColor" stroke="none"/>
      <rect x="13.2" y="16" width="3.4" height="4" fill="currentColor" stroke="none"/>
      <rect x="17.8" y="18" width="3.4" height="2" fill="currentColor" stroke="none"/>
      <polyline points="5.7 8 10.3 5.2 14.9 4 19.5 3.4"/>
    </>
  ),
  table: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="1"/>
      <line x1="4" y1="9.5" x2="20" y2="9.5"/>
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="4" y1="14.5" x2="20" y2="14.5"/>
    </>
  ),
  pivot: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="1"/>
      <rect x="4" y="5" width="16" height="4.5" fill="currentColor"/>
      <rect x="4" y="9.5" width="5" height="9.5" fill="currentColor" opacity="0.35"/>
      <line x1="9" y1="5" x2="9" y2="19"/>
      <line x1="14.5" y1="5" x2="14.5" y2="19"/>
      <line x1="4" y1="14.5" x2="20" y2="14.5"/>
    </>
  ),
  cohort: (
    <>
      <path d="M4 4h16v4h-4v4h-4v4H8v4H4z"/>
      <rect x="4" y="4" width="4" height="16" fill="currentColor"/>
      <rect x="8" y="4" width="4" height="12" fill="currentColor" opacity="0.5"/>
    </>
  ),
  event_funnel: (
    <>
      <rect x="4" y="4" width="16" height="3.5" rx="0.5" fill="currentColor"/>
      <rect x="4" y="10.25" width="11" height="3.5" rx="0.5" fill="currentColor" opacity="0.7"/>
      <rect x="4" y="16.5" width="6" height="3.5" rx="0.5" fill="currentColor" opacity="0.45"/>
      <path d="M20 9.5l-4 2M15 15.75l-4 2"/>
    </>
  ),
  map_bubble: (
    <>
      <circle cx="12" cy="12" r="8"/>
      <circle cx="9" cy="10" r="1.6" fill="currentColor"/>
      <circle cx="15" cy="14" r="2.2" fill="currentColor"/>
    </>
  ),
  map_choropleth: (
    <>
      <path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2z"/>
      <path d="M9 4v14M15 6v14"/>
    </>
  ),
  word_cloud: (
    <>
      <path d="M6 11h9" strokeWidth="2.6"/>
      <path d="M4 15.5h5M11.5 15.5h8"/>
      <path d="M8 7h6M16.5 7h3M7 19.5h4M13.5 19.5h4.5" strokeWidth="1.2"/>
      <path d="M17 11h2.5" strokeWidth="1.8"/>
    </>
  ),
  map_hexbin: (
    <>
      <path d="M7.5 3.5 11 5.5v4L7.5 11.5 4 9.5v-4z" fill="currentColor"/>
      <path d="M16.5 3.5 20 5.5v4l-3.5 2L13 9.5v-4z"/>
      <path d="M12 11.5l3.5 2v4L12 19.5l-3.5-2v-4z" fill="currentColor" opacity="0.5"/>
    </>
  ),
  map_flow: (
    <>
      <circle cx="5" cy="17" r="2" fill="currentColor"/>
      <circle cx="19" cy="7" r="2" fill="currentColor"/>
      <path d="M6.5 15.5C9 8 14 6 17.2 6.6"/>
      <path d="M6.8 18.2C11 19 16 15.5 18.2 9"/>
    </>
  ),
};

export function VizIcon({ type, size = 16, className }: { type: string; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[type] ?? GLYPHS.column}
    </svg>
  );
}
