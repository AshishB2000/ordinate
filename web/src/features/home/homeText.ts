// Home's words — pure functions, ported from homeAsk.ts / homePage.ts. Every
// figure here is one the server returned; these only write it out.

import type { RecentItem, RecentType } from '../../api/home';

export const TYPE_LABEL: Record<RecentType, string> = {
  dataset: 'Dataset',
  analysis: 'Dashboard',
  capture: 'Capture',
  report: 'Report',
  visual: 'Visual',
};

/** The name to greet: an email's local part up to the first separator, capitalised ("ana.ruiz@x" → "Ana"). */
export function displayName(email: string | undefined): string {
  const first = (email ?? '').split('@')[0]!.split(/[._+-]/)[0]!.trim();
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}

/** haGreetingText: the same thresholds (5/12/17/22); with no name, nobody to greet. */
export function greeting(name: string, hour: number): string {
  if (!name) return 'Welcome back';
  if (hour >= 5 && hour < 12) return `Good morning, ${name}`;
  if (hour >= 12 && hour < 17) return `Good afternoon, ${name}`;
  if (hour >= 17 && hour < 22) return `Good evening, ${name}`;
  return `Good to see you, ${name}`; // late night — "Good night" reads as a goodbye
}

const num = new Intl.NumberFormat();

/** "1 dataset" / "3 datasets", the count as the server gave it. */
export function plural(n: number, word: string): string {
  return `${num.format(n)} ${word}${n === 1 ? '' : 's'}`;
}

/** homeMetaText: what a Recent row IS — "1,240 rows × 5 columns", "3 sheets", or ''. */
export function metaText(it: Pick<RecentItem, 'type' | 'meta'>): string {
  const m = it.meta ?? {};
  if (it.type === 'dataset') {
    const parts: string[] = [];
    if (typeof m.rowCount === 'number') parts.push(plural(m.rowCount, 'row'));
    if (typeof m.columnCount === 'number') parts.push(plural(m.columnCount, 'column'));
    return parts.join(' × ');
  }
  if (it.type === 'analysis' && typeof m.sheetCount === 'number') return plural(m.sheetCount, 'sheet');
  return '';
}

/** dsRules dqDot's label; '' when nothing fails. */
export function qualityLabel(failing: number | undefined): string {
  if (typeof failing !== 'number' || failing <= 0) return '';
  return `Data quality: ${num.format(failing)} ${failing === 1 ? 'rule' : 'rules'} failing`;
}

// i18n-skip: a dataset NAME — src/app/sampleProject.ts SAMPLE_DATASET_NAME.
export const SAMPLE_DATASET = 'Retail orders';
const SAMPLE_PROMPTS = ['Which region had the worst month?', 'Revenue by category this year'];

const sampleOnly = (names: string[]) => names.length === 1 && names[0] === SAMPLE_DATASET;

/**
 * haSuggestPrompts: up to three starter questions from REAL dataset names —
 * strings only, never a figure, never a model call. The bundled sample gets
 * questions written for it; a project with no datasets falls back to the
 * datasets in Recent (first launch: the sample may sit in another project).
 */
export function suggestPrompts(projectDatasets: string[], recentDatasets: string[]): string[] {
  const names = projectDatasets.map((n) => n.trim()).filter(Boolean);
  if (sampleOnly(names)) return [...SAMPLE_PROMPTS];
  if (!names.length) return sampleOnly(recentDatasets.map((n) => n.trim())) ? [...SAMPLE_PROMPTS] : [];
  const out = [`What stands out in ${names[0]}?`];
  if (names.length > 1) out.push(`How do ${names[0]} and ${names[1]} compare?`);
  out.push(`Summarise ${names[0]} in plain terms`);
  return out.slice(0, 3);
}

/** Where a Recent row opens: the record itself where it has a page, else its section. */
export function itemHref(it: Pick<RecentItem, 'type' | 'id' | 'projectId'>): string {
  switch (it.type) {
    case 'dataset':
      return `/data/${it.projectId}/${it.id}`;
    case 'analysis':
      return `/analyses/${it.projectId}/${it.id}`;
    case 'visual':
      return `/visuals/${it.projectId}/${it.id}`;
    case 'report':
      return '/reports';
    default:
      return '/data';
  }
}

/** The import page in `projectId` (the current project when there is none yet), on one source. */
export function importPath(projectId: string | undefined, source?: string): string {
  const q = new URLSearchParams();
  if (projectId) q.set('project', projectId);
  if (source) q.set('source', source);
  return q.size ? `/data/import?${q.toString()}` : '/data/import';
}
