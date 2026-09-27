// Which filter-bar states a published dashboard can show — PURE.
//
// A published site has no server, so every state its filter bar can reach has
// to be computed by the app in advance and shipped as data. That makes the
// filter bar a finite menu: each control gets a short list of OPTIONS (the
// first is always "All" — no filter), and a COMBINATION is one option per
// control. The site embeds one aggregate per tile per combination, keyed by
// the option indexes ("0.2.1").
//
// THE CAP. The full product explodes (three controls of 20 values is 9,261
// states), so there are two modes:
//   'all'     every combination — used when the product fits the cap;
//   'single'  the default state plus every state that differs from it in ONE
//             control — Σ(options−1)+1 states. The published filter bar then
//             changes one control at a time and says so.
// If even 'single' does not fit, each control's option list is trimmed (the
// least frequent values go first, since the caller lists options by count)
// until it does, and every trimmed value is reported so the dialog can say
// what was dropped.

export const DEFAULT_MAX_COMBOS = 256;
export const MAX_OPTIONS_PER_CONTROL = 60;

export interface ControlDomain {
  /** Stable id (the control card's id). */
  id: string;
  label: string;
  /** Option labels, index 0 = "All". */
  options: string[];
  /** Index of the option the dashboard opens on. */
  defaultIndex: number;
}

export interface ComboPlan {
  mode: 'all' | 'single';
  /** Keys, one per combination, in the order payloads are stored. */
  keys: string[];
  /** The domains AFTER trimming — what the published filter bar offers. */
  domains: ControlDomain[];
  /** Options trimmed away to fit the cap, per control label. */
  dropped: Array<{ control: string; options: string[] }>;
  /** How many combinations the full product would have been. */
  fullCount: number;
}

/** The key of one state: option indexes joined by '.'; '' for no controls. */
export function comboKey(indexes: number[]): string {
  return indexes.join('.');
}

export function parseKey(key: string): number[] {
  return key === '' ? [] : key.split('.').map((n) => Number(n));
}

function product(domains: ControlDomain[]): number {
  return domains.reduce((n, d) => n * Math.max(1, d.options.length), 1);
}

function singleCount(domains: ControlDomain[]): number {
  return 1 + domains.reduce((n, d) => n + Math.max(0, d.options.length - 1), 0);
}

/** Every combination, first control varying slowest (a stable, testable order). */
export function enumerateAll(domains: ControlDomain[]): string[] {
  let acc: number[][] = [[]];
  for (const d of domains) {
    const next: number[][] = [];
    for (const prefix of acc) for (let i = 0; i < Math.max(1, d.options.length); i++) next.push([...prefix, i]);
    acc = next;
  }
  return acc.map(comboKey);
}

/** The default state, then each control's other options with the rest at default. */
export function enumerateSingle(domains: ControlDomain[]): string[] {
  const base = domains.map((d) => clampIndex(d.defaultIndex, d.options.length));
  const out = [comboKey(base)];
  domains.forEach((d, c) => {
    for (let i = 0; i < d.options.length; i++) {
      if (i === base[c]) continue;
      const k = base.slice();
      k[c] = i;
      out.push(comboKey(k));
    }
  });
  return out;
}

function clampIndex(i: number, n: number): number {
  return Number.isInteger(i) && i >= 0 && i < n ? i : 0;
}

/**
 * Plan the combinations for a dashboard's controls under `maxCombos`.
 * Options beyond MAX_OPTIONS_PER_CONTROL are trimmed first (reported), then the
 * mode is chosen, then — if still over — the longest option lists are trimmed
 * one value at a time. The default option is never trimmed.
 */
export function planCombos(input: ControlDomain[], maxCombos = DEFAULT_MAX_COMBOS): ComboPlan {
  const cap = Math.max(1, Math.floor(maxCombos));
  const droppedBy = new Map<string, string[]>();
  const drop = (d: ControlDomain, i: number): void => {
    const list = droppedBy.get(d.label) || [];
    list.push(d.options[i]);
    droppedBy.set(d.label, list);
    d.options.splice(i, 1);
    if (d.defaultIndex > i) d.defaultIndex--;
  };
  const domains: ControlDomain[] = input.map((d) => ({
    id: d.id,
    label: d.label,
    options: d.options.length ? d.options.slice() : ['All'],
    defaultIndex: clampIndex(d.defaultIndex, Math.max(1, d.options.length)),
  }));
  for (const d of domains) {
    while (d.options.length > MAX_OPTIONS_PER_CONTROL && lastTrimmable(d) >= 0) drop(d, lastTrimmable(d));
  }
  const fullCount = product(input.map((d) => ({ ...d, options: d.options.length ? d.options : ['All'] })));

  if (product(domains) <= cap) {
    return { mode: 'all', keys: enumerateAll(domains), domains, dropped: report(droppedBy), fullCount };
  }
  while (singleCount(domains) > cap) {
    // Trim the longest list that still HAS a trimmable option; ties go to the
    // later control (earlier ones are usually the ones the author put first on
    // purpose). "All" and each default are never trimmed, so a control whose
    // default is a value keeps two options — the floor the cap cannot go under.
    let longest = -1;
    domains.forEach((d, i) => {
      if (lastTrimmable(d) >= 0 && (longest < 0 || d.options.length >= domains[longest].options.length)) longest = i;
    });
    if (longest < 0) break;
    drop(domains[longest], lastTrimmable(domains[longest]));
  }
  return { mode: 'single', keys: enumerateSingle(domains), domains, dropped: report(droppedBy), fullCount };
}

/** The last option that is neither "All" (index 0) nor the default; -1 when none is. */
function lastTrimmable(d: ControlDomain): number {
  for (let i = d.options.length - 1; i > 0; i--) if (i !== d.defaultIndex) return i;
  return -1;
}

function report(m: Map<string, string[]>): Array<{ control: string; options: string[] }> {
  return [...m].map(([control, options]) => ({ control, options }));
}

/**
 * The dialog's line: "12 control combinations · 2.1 MB". One combination (no
 * controls) reads "No filter bar · 380 KB".
 */
export function summaryLine(combos: number, bytes: number): string {
  const size = formatBytes(bytes);
  if (combos <= 1) return `No filter bar · ${size}`;
  return `${combos.toLocaleString('en-US')} control combinations · ${size}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}
