// A dashboard tile's drill, where the dashboard is READ (semantic layer D5, D6). `offer` says whether a clicked mark can
// drill and what it would go to; running it asks `visual:drillDown`, and the reply joins the reader's view state
// (`ed.view.drillInto`). The tile, its rows drawer, Explain and ⋯ then read the one drilled definition. Nothing here
// computes a figure; an older pod that has no navigation or no drill leaves the click as it was.

import { useMemo, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '../../ui/Toast';
import type { Card, Step, VisualDef } from '../analyses/api';
import type { EditorApi } from '../analyses/editor/context';
import { mergeFilters } from '../analyses/VisualTile';
import { loadNavigation, navFor } from '../model/navigation';
import { DRILL_FAILED, drillableAxis, drillDown } from '../visuals/drill/drillApi';
import { DrillCrumbs } from '../visuals/drill/DrillCrumbs';
import type { Encoding } from '../visuals/encoding';
import { levelOf } from '../../../../src/analysis/drillLevels.ts';
import { tileFilters } from './CardRuntime';
import { isPhoneReader } from './phone/phoneBlocks';
import { drilledDef } from './tileDrill';

/** A clicked mark: as the server names it, as the axis drew it, and whether (and how finely) the axis is a date. */
export interface DrillAt {
  category: string | number;
  series?: string;
  shown: string;
  time: boolean;
  grain?: string;
}
/** What a drill would go to ("state", "day") and the way to do it. */
export interface DrillOffer {
  word: string;
  run: () => void;
}

export function useTileDrill(ed: EditorApi, card: Card, saved: VisualDef): { def: VisualDef; drilled: boolean; staleTime: number | undefined; crumbs: ReactNode; offer: (at: DrillAt) => Promise<DrillOffer | null> } {
  const qc = useQueryClient();
  const drill = ed.view.drills.get(card.id);
  const def = useMemo(() => drilledDef(saved, drill), [saved, drill]);
  const busy = useRef(false);
  const used = useRef(false); // this tile has drilled: its cached levels stay fresh for a minute, so Up asks nothing

  const offer = async (at: DrillAt): Promise<DrillOffer | null> => {
    // Drill only where the dashboard is read: the view page, Present, and a phone (which reads the editing route too).
    if (!(ed.viewing || ed.view.presenting || isPhoneReader(ed))) return null;
    const nav = await loadNavigation(qc, ed.projectId);
    if (!nav) return null;
    const hierarchies = navFor(nav, def.datasetId);
    const axis = drillableAxis({ chartType: def.chartType, encoding: def.encoding as Encoding, category: { kind: at.time ? 'date' : 'text', grain: at.grain }, hierarchies, ladder: nav.dateLadder });
    if (!axis) return null;
    const run = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const r = await drillDown({
          projectId: ed.projectId,
          datasetId: def.datasetId,
          encoding: def.encoding as Encoding,
          filters: mergeFilters(tileFilters(ed, card.id), def.filters) as never,
          params: ed.params as never,
          mark: { category: at.category, ...(at.series !== undefined ? { series: at.series } : {}) },
        });
        if (!r.ok) toast(DRILL_FAILED, { kind: 'error' });
        else if (!r.available) toast(r.reason);
        else {
          used.current = true;
          const root = levelOf(hierarchies, def.encoding.category)?.hierarchy.name ?? 'All dates';
          ed.view.drillInto(card.id, root, { encoding: r.encoding as VisualDef['encoding'], steps: r.steps as Step[], crumb: { label: r.crumb.label, next: r.crumb.next, word: axis.word } });
        }
      } finally {
        busy.current = false;
      }
    };
    return { word: axis.word, run: () => void run() };
  };

  const last = drill?.levels.at(-1);
  const crumbs =
    drill && last ? (
      <DrillCrumbs
        crumbs={[{ label: drill.root, go: () => ed.view.drillUp(card.id, 0) }, ...drill.levels.map((l, i) => ({ label: l.crumb.label, go: i < drill.levels.length - 1 ? () => ed.view.drillUp(card.id, i + 1) : undefined }))]}
        by={last.crumb.word}
        onUp={() => ed.view.drillUp(card.id, drill.levels.length - 1)}
      />
    ) : null;
  return { def, drilled: !!drill, staleTime: used.current ? 60_000 : undefined, crumbs, offer };
}
