'use strict';

// The published site's renderer, PURE half, continued: the page's WORDS — the
// sheet's takeaway sentence under the title, the figures inside it, a change in
// percent. A classic script inlined right after publishCore.js (src/publish/
// publish.ts readAssets joins the two); every name prefixed `pk`. Like the core
// it computes no figure: it picks which of the server's sentences to show and
// marks the figures the server wrote into it.

/**
 * The sheet's one-sentence takeaway under the dashboard's title: the server's caption
 * (analysis/captions.ts) of the first chart in reading order — layout row, then column —
 * for this combination, else the first KPI's. `at` names the card by its index in the
 * sheet, so the page does not say the same sentence again under it.
 */
function pkTakeaway(cards: any[], combo: number): { at: number; text: string } | null {
  const order = cards.map((_c, i) => i).sort((a, b) => cards[a].layout.y - cards[b].layout.y || cards[a].layout.x - cards[b].layout.x || a - b);
  const said = (i: number): string => {
    const p = pkPayload(cards[i], combo);
    return p && !p.error && !p.hidden && typeof p.caption === 'string' ? p.caption.trim() : '';
  };
  for (const kind of ['chart', 'metric']) {
    const at = order.find((i) => cards[i].kind === kind && said(i));
    if (at !== undefined) return { at, text: said(at) };
  }
  return null;
}

/**
 * A figure inside a caption — "$2.1M", "2,612", "83%", "1.3×", "−4.1%": a number with a currency, a
 * separator or a unit. A bare integer ("Jan 2024") is not one, nor a digit inside a word ("region0").
 */
const PK_FIGURE = /(?<![\p{L}\p{N}_.,])[−+-]?(?:[$€£¥]\d+(?:[.,]\d+)*(?:[KMBT](?!\p{L})|%|×)?|\d+(?:[.,]\d+)+(?:[KMBT](?!\p{L})|%|×)?|\d+(?:[KMBT](?!\p{L})|%|×))/gu;

/** A sentence cut into runs, the figures marked — the page sets each figure in bold. Text is never parsed as HTML. */
function pkFigureRuns(text: string): Array<{ text: string; figure: boolean }> {
  const out: Array<{ text: string; figure: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(PK_FIGURE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), figure: false });
    out.push({ text: m[0], figure: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), figure: false });
  return out;
}

/** A change in percent as the canvas writes it (MetricCard kpiPct): "+18.2%" / "−4.1%" — one decimal under 10%, none above. */
function pkPct(pct: number, fmt: (v: number, maxDecimals: number) => string): string {
  const a = Math.abs(pct);
  return (pct > 0 ? '+' : pct < 0 ? '−' : '') + fmt(a, a < 10 ? 1 : 0) + '%';
}
