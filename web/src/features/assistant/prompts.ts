// The dock's starter chips — homeAsk.ts's haSuggestPrompts, the ONE chip
// generator (Home's ask bar reuses it when T2.1 ports Home). Up to three,
// built from record NAMES only: never a figure, never a model call. A chip
// fills the composer; it never sends.

/** Mirrors SAMPLE_DATASET_NAME in src/app/sampleProject.ts (scripts/test-sampleProject.ts pins the desktop copy). */
export const SAMPLE_DATASET = 'Retail orders';
const SAMPLE_PROMPTS = ['Which region had the worst month?', 'Revenue by category this year'];

/** What a person asks about the thing on screen — each answerable from the facts the server builds for that kind (src/ipc/copilot.ts buildFacts). */
const ABOUT = new Map<string, (name: string) => string[]>([
  ['visual', (n) => [`What does ${n} show?`, `What stands out in ${n}?`, `Summarise ${n} in plain terms`]],
  ['analysis', (n) => [`What does ${n} show?`, `What are the key figures in ${n}?`, `Summarise ${n} in plain terms`]],
  ['scorecard', (n) => [`What is off track in ${n}?`, `What changed in ${n}?`, `Summarise ${n} in plain terms`]],
  ['scenario', (n) => [`What changes most in ${n}?`, `Which driver matters most in ${n}?`, `Summarise ${n} in plain terms`]],
]);

/**
 * `preferred` is the dock's context and `kind` what it is: an open visual,
 * analysis, scorecard or scenario gets questions of its own; an open dataset
 * leads instead of the project's first.
 */
export function starterPrompts(datasetNames: readonly string[], preferred = '', kind = ''): string[] {
  const lead = preferred.trim();
  const about = ABOUT.get(kind);
  if (lead && about) return about(lead);
  let names = datasetNames.map((n) => n.trim()).filter(Boolean);
  // The bundled sample gets questions written for it (it has a planted bad month for the first).
  if (names.length === 1 && names[0] === SAMPLE_DATASET) return [...SAMPLE_PROMPTS];
  if (!names.length) return [];
  if (lead) names = [lead, ...names.filter((n) => n !== lead)];
  const out = [`What stands out in ${names[0]}?`];
  if (names.length > 1) out.push(`How do ${names[0]} and ${names[1]} compare?`);
  out.push(`Summarise ${names[0]} in plain terms`);
  return out.slice(0, 3);
}
