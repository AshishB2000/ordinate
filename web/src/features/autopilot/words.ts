// The report's sentences, from the structured rows the server wrote (the web is English only). Times arrive in ms and are only shown as seconds.

import type { Gone, Item, Run } from './api';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
export const seconds = (ms: number): string => `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`;

const WHY: Record<Gone['why'], (g: Gone) => string> = {
  none: () => 'No rename of it was recorded, so Autopilot cannot tell what it became.',
  again: () => 'It was renamed again since, so the first rename no longer explains it.',
  target_missing: () => 'The column it was renamed to is gone too.',
  other_fields: () => 'Another part of the chart (a map\u2019s colour, a facet, a funnel or an overlay) uses it too, so Autopilot left it for you.',
  repair_off: (g) => `Autopilot would use ${g.suggest ?? 'the renamed column'}; repairs are switched off.`,
};

/** The row's main sentence and, under it, why or how. */
export function describe(it: Item, dataset: string): { words: string; sub?: string } {
  const d = it.detail;
  switch (it.kind) {
    case 'trashed':
      if (it.state === 'listed') return { words: `Would move to Trash: not opened in ${plural(d.days ?? 0, 'day')}`, sub: 'Moving unused charts is switched off.' };
      if (it.state === 'failed') return { words: 'Could not move it to Trash', sub: 'You need edit access to the folder it is in.' };
      return { words: `Moved to Trash: not opened in ${plural(d.days ?? 0, 'day')}`, sub: 'It stays in Trash for 90 days.' };
    case 'repaired': {
      const fixes = (d.fixes ?? []).map((f) => `${f.to} (was ${f.from})`).join(', ');
      if (it.state === 'failed') return { words: `Could not repair ${fixes}` };
      return { words: `Now uses ${fixes}`, sub: `A rename in ${d.datasetName || dataset}. The old version is in its history.` };
    }
    case 'broken': {
      const gone = d.gone ?? [];
      return { words: gone.map((g) => `Uses ${g.column}, which is gone from ${d.datasetName || dataset}`).join('. '), sub: gone.map((g) => WHY[g.why](g)).join(' ') };
    }
    case 'slow':
      return { words: `Takes about ${seconds(d.avgMs ?? 0)} on ${d.datasetName || dataset}`, sub: `Slowest ${seconds(d.maxMs ?? 0)}, over ${plural(d.computes ?? 0, 'run')} this week.` };
  }
}

export const stateWord = (r: Run): string => ({ running: 'Running', done: 'Done', paused: 'Paused', failed: 'Failed' })[r.state];
