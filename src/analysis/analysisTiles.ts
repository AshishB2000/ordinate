// A dashboard's tiles, flattened — MAIN. Moved out of ./analysis.ts (the store), which re-exports it.

import type { Analysis } from './analysis';
import type { CardType } from './dashboards';
import * as visuals from './visuals';

// ── The dashboard's own inventory, flattened ────────────────────────────────
//
// ONE read model, two consumers: the FACTS the Assistant is given about an open
// dashboard (src/ai/copilot.ts analysisFacts) and the context its edit-delta
// validator resolves tile names against (src/analysis/dashboardDelta.ts). They
// must agree — the model can only name a tile the app can then find, so a second
// copy of this walk is how "the Assistant edited the wrong chart" happens.
//
// A visual card stores only `visualId`; its title, chart type and encoding live
// on the separate Visual record, which is why this is async and why the card
// walk alone was never enough.
//
// NAMES ONLY. Column names and aggregation names, never a value and never a
// figure — the same rule every other AI-facing builder in this codebase follows.

export interface AnalysisTile {
  cardId: string;
  /** 0-based index of the page the tile sits on. */
  pageIndex: number;
  type: CardType;
  /** Visual name, metric label, text heading or control label — whatever the
   *  user would actually call this tile when asking to change it. */
  title: string;
  visualId?: string;
  datasetId?: string;
  chartType?: string;
  /** The dimension column, for a visual. A NAME, not its values. */
  category?: string;
  /** Measures as "sum(revenue)" — aggregation + column NAME only. */
  measures?: string[];
}

/** Flatten an Analysis into its tiles, resolving each visual card's Visual
 *  record. A deleted Visual leaves the tile in place with a plain title, so a
 *  broken card is still nameable rather than invisible. */
export async function listAnalysisTiles(projectId: string, a: Analysis): Promise<AnalysisTile[]> {
  const out: AnalysisTile[] = [];
  const seen = new Map<string, Pick<visuals.Visual, 'name' | 'datasetId' | 'chartType' | 'encoding'> | null>();
  const pages = Array.isArray(a && a.sheets) ? a.sheets : [];
  for (let p = 0; p < pages.length; p += 1) {
    const cards = Array.isArray(pages[p].cards) ? pages[p].cards : [];
    for (const card of cards) {
      if (!card || typeof card !== 'object' || !card.id) continue;
      const tile: AnalysisTile = { cardId: card.id, pageIndex: p, type: card.type, title: '' };
      if (card.type === 'visual' && (card.visualId || card.visual)) {
        if (card.visualId) tile.visualId = card.visualId;
        // A published copy's card draws its frozen definition, never the chart as it is now.
        let v: Pick<visuals.Visual, 'name' | 'datasetId' | 'chartType' | 'encoding'> | null | undefined = card.visual ?? seen.get(card.visualId!);
        if (v === undefined) {
          v = await visuals.getVisual(projectId, card.visualId!);
          seen.set(card.visualId!, v);
        }
        if (v) {
          tile.title = v.name;
          tile.datasetId = v.datasetId;
          tile.chartType = v.chartType;
          if (v.encoding && typeof v.encoding.category === 'string') tile.category = v.encoding.category;
          const vals = v.encoding && Array.isArray(v.encoding.values) ? v.encoding.values : [];
          tile.measures = vals.map((m) => `${m.aggregation}(${m.column})`);
        } else {
          tile.title = '(deleted visual)';
        }
      } else if (card.type === 'metric' && card.metric) {
        tile.title = card.metric.label || `${card.metric.aggregation}(${card.metric.column})`;
        tile.datasetId = card.metric.datasetId;
      } else if (card.type === 'text') {
        tile.title = card.heading || 'Text';
      } else if (card.type === 'control' && card.control) {
        const param = card.control.kind === 'parameter' ? (a.parameters || []).find((x) => x.id === card.control!.paramId) : undefined;
        tile.title = card.control.label || (param ? param.name : card.control.column);
        if (card.control.datasetId) tile.datasetId = card.control.datasetId;
      }
      if (!tile.title) tile.title = card.type;
      out.push(tile);
    }
  }
  return out;
}
