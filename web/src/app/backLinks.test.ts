// One way back (docs/design-floor): a page's crumb to its parent is Page's
// `back`, drawn by blocks.tsx. Every other back icon — an `arrow-left` or
// `chevron-left` named anywhere in a .ts or .tsx file, however it is wired
// (a Link, a Button whose handler navigates under any name, a menu item in a
// .ts table) — or a "← Word" written into the UI is a finding, unless the file is
// on STEP_BACKS below with the exact count and the reason it is not a page's
// way back. The files are parsed (oxc, through Vite), not grepped.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';

type Node = { type: string; start: number; [k: string]: unknown };

const BACK_ICON = /^(arrow-left|chevron-left)$/;
/** "← Data", "← Back": the arrow before a word. Not "←/→" (a key hint) or "{to} ←" (a mapping arrow). */
const BACK_GLYPH = /←\s+\p{L}/u;
const SRC = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const ALLOWED = path.join(SRC, 'app', 'blocks.tsx');
/** The icon set itself names every glyph. */
const SKIP = [path.join(SRC, 'ui', 'icons', 'paths.ts')];

/**
 * Back icons that are not a page's way back: a step back inside a flow on the same page, a pager,
 * or content an author places. Each entry is the exact number of back icons the file holds; one more
 * (or one fewer) fails, so a new use is looked at, and a fixed file leaves the list.
 */
const STEP_BACKS: Record<string, [count: number, reason: string]> = {
  'features/settings/ThemeEditor.tsx': [1, 'closes the in-page theme editor, back to the theme list on the same page'],
  'features/admin/AuditTab.tsx': [1, 'a pager: the previous page of the audit log'],
  'features/subscriptions/SubscribeDialog.tsx': [1, 'the dialog\'s previous step'],
  'features/connections/ConnectionForm.tsx': [1, '"Change source": back to the picker on the same page'],
  'features/dashboards/tileActions.tsx': [1, 'the viewer\'s drill-back: restores the sheet and carried filters of the dashboard a navigate action came from (viewer state, not the page\'s parent)'],
  'features/analyses/editor/AddKpi.tsx': [1, 'the dialog\'s previous step'],
  'features/analyses/editor/Canvas.tsx': [1, '"Narrower": a resize of a card, not a direction of travel'],
  'features/analyses/editor/KindCards.tsx': [2, 'a navigation card an author styles as "back": content on the sheet'],
  'features/analyses/NewWizard.tsx': [1, 'the wizard\'s previous step'],
  'features/visuals/NewVisualDialog.tsx': [1, 'the dialog\'s previous step'],
  'features/import/Composer.tsx': [1, '"Back to sources": back to the source list on the same page'],
  'features/reports/stories/Present.tsx': [1, 'a pager: the previous slide'],
  'features/reports/scorecards/ScorecardPage.tsx': [1, 'a pager: the previous period'],
};

function visit(node: unknown, fn: (n: Node) => void): void {
  if (Array.isArray(node)) node.forEach((n) => visit(n, fn));
  else if (node && typeof node === 'object') {
    if (typeof (node as Node).type === 'string') fn(node as Node);
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v, fn);
  }
}

/** The line of every back icon and every "← Word" a source puts on screen (comments are not nodes, so not counted). */
export function backMarks(file: string, source: string): number[] {
  const { program, errors } = parseSync(file, source);
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  const lines: number[] = [];
  const line = (n: Node) => source.slice(0, n.start).split('\n').length;
  visit(program, (n) => {
    const text =
      n.type === 'Literal' && typeof n.value === 'string' ? n.value
      : n.type === 'TemplateElement' ? String((n.value as { cooked?: string } | undefined)?.cooked ?? '')
      : n.type === 'JSXText' ? String(n.value)
      : null;
    if (text !== null && (BACK_ICON.test(text) || BACK_GLYPH.test(text))) lines.push(line(n));
  });
  return lines;
}

/** Back marks per file (relative to `dir`), every .ts/.tsx but tests, blocks.tsx and the icon set. */
function scan(dir: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const file = path.join(e.parentPath, e.name);
    if (!e.isFile() || !/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file) || /\.d\.ts$/.test(file) || file === ALLOWED || SKIP.includes(file)) continue;
    const marks = backMarks(file, readFileSync(file, 'utf8'));
    if (marks.length) out.set(path.relative(dir, file), marks);
  }
  return out;
}

/** Every back mark not covered by STEP_BACKS, and every STEP_BACKS entry that no longer matches. */
function problems(found: Map<string, number[]>, allowed: Record<string, [number, string]>): string[] {
  const out: string[] = [];
  for (const [file, lines] of found) {
    const want = allowed[file]?.[0] ?? 0;
    if (lines.length !== want) out.push(`${file}: ${lines.length} back icon(s) at line ${lines.join(', ')}; ${want} allowed`);
  }
  for (const file of Object.keys(allowed)) if (!found.has(file)) out.push(`${file}: on STEP_BACKS but holds no back icon (drop the entry)`);
  return out;
}

describe('one way back', () => {
  it('no back link outside blocks.tsx but the commented step-backs', () => {
    expect(problems(scan(SRC), STEP_BACKS)).toEqual([]);
  });

  it('every step-back says why it is not a way back', () => {
    for (const [file, [count, reason]] of Object.entries(STEP_BACKS)) expect(count > 0 && reason.length > 10, file).toBe(true);
  });

  it('catches a back link however it is wired, in .tsx and .ts (negative control)', () => {
    // A level down, as a feature file is: the scan walks the tree.
    const dir = mkdtempSync(path.join(tmpdir(), 'backlinks-'));
    mkdirSync(path.join(dir, 'features'));
    const plant = (name: string, body: string) => writeFileSync(path.join(dir, 'features', name), body);
    plant('Link.tsx', 'export const A = () => <Link to="/data"><Icon name="arrow-left" /><span>Data</span></Link>;\n');
    plant('Alias.tsx', 'export function B() {\n  const nav = useNavigate();\n  return <Button icon="arrow-left" onClick={() => nav(`/visuals`)}>Back</Button>;\n}\n');
    plant('Handler.tsx', 'export function C({ goBack }: { goBack: () => void }) {\n  return <IconButton icon="chevron-left" label="Back" onClick={goBack} />;\n}\n');
    plant('Glyph.tsx', 'export const D = () => <a href="/data">← Data</a>;\n');
    // Not back links: a key hint and a mapping arrow.
    plant('Hints.tsx', 'export const H = ({ to }: { to: string }) => <p>Use ←/→ to move. <span>{to} ←</span></p>;\n');
    plant('menu.ts', "export const items = [{ label: 'Back', icon: 'arrow-left', onSelect: () => go('/x') }];\n");
    plant('Allowed.tsx', 'export const E = () => <><Button icon="chevron-left" onClick={prev}>Back</Button><Button icon="chevron-left" onClick={prev2}>Back</Button></>;\n');
    const found = scan(dir);
    expect(problems(found, { 'features/Allowed.tsx': [1, 'a planted pager, allowed once'] }).sort()).toEqual([
      'features/Alias.tsx: 1 back icon(s) at line 3; 0 allowed',
      'features/Allowed.tsx: 2 back icon(s) at line 1, 1; 1 allowed',
      'features/Glyph.tsx: 1 back icon(s) at line 1; 0 allowed',
      'features/Handler.tsx: 1 back icon(s) at line 2; 0 allowed',
      'features/Link.tsx: 1 back icon(s) at line 1; 0 allowed',
      'features/menu.ts: 1 back icon(s) at line 1; 0 allowed',
    ]);
    // …and a step-back entry that outlived its use is a finding too.
    expect(problems(new Map(), { 'features/Gone.tsx': [1, 'a pager that was removed'] })).toEqual(['features/Gone.tsx: on STEP_BACKS but holds no back icon (drop the entry)']);
  });

  it('would see the one it allows: blocks.tsx draws the crumb', () => {
    expect(backMarks('app/blocks.tsx', readFileSync(ALLOWED, 'utf8'))).toHaveLength(1);
  });
});
