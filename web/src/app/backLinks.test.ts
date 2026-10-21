// One way back (docs/design-floor): a page's crumb to its parent is Page's
// `back`, drawn by blocks.tsx. This fails on a back link built anywhere else —
// a <Link>, <NavLink> or <a> holding an arrow-left or chevron-left icon, or a
// <Button>/<IconButton> with that icon whose onClick navigates. A step back
// inside a flow (a wizard's Back, a pager) does not navigate and is not one.
// The files are parsed (oxc, through Vite), not grepped.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';

type Node = { type: string; start: number; [k: string]: unknown };
type El = Node & { openingElement: { name: { type: string; name?: string }; attributes: Array<Node & { name?: { name?: string }; value?: Node & { value?: unknown } }> } };

const BACK_ICONS = new Set(['arrow-left', 'chevron-left']);
const LINKS = new Set(['Link', 'NavLink', 'a']);
const BUTTONS = new Set(['Button', 'IconButton']);
const SRC = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const ALLOWED = path.join(SRC, 'app', 'blocks.tsx');

function visit(node: unknown, fn: (n: Node) => void): void {
  if (Array.isArray(node)) node.forEach((n) => visit(n, fn));
  else if (node && typeof node === 'object') {
    if (typeof (node as Node).type === 'string') fn(node as Node);
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v, fn);
  }
}

const tag = (el: El) => (el.openingElement.name.type === 'JSXIdentifier' ? el.openingElement.name.name ?? '' : '');
const attr = (el: El, name: string) => el.openingElement.attributes.find((a) => a.type === 'JSXAttribute' && a.name?.name === name);
/** A left arrow anywhere inside: `<Icon name="arrow-left" />`, `icon="chevron-left"`. */
function holdsBackIcon(el: Node): boolean {
  let hit = false;
  visit(el, (n) => {
    const a = n as El['openingElement']['attributes'][number];
    if (n.type === 'JSXAttribute' && (a.name?.name === 'name' || a.name?.name === 'icon') && BACK_ICONS.has(String(a.value?.value))) hit = true;
  });
  return hit;
}

/** Every back link `source` renders, as `file:line <Tag>`. */
export function backLinks(file: string, source: string): string[] {
  const { program, errors } = parseSync(file, source);
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  const out: string[] = [];
  const at = (n: Node) => `${file}:${source.slice(0, n.start).split('\n').length}`;
  visit(program, (n) => {
    if (n.type !== 'JSXElement') return;
    const el = n as El;
    const name = tag(el);
    if (LINKS.has(name) && holdsBackIcon(el)) out.push(`${at(el)} <${name}>`);
    if (BUTTONS.has(name) && BACK_ICONS.has(String(attr(el, 'icon')?.value?.value))) {
      const click = attr(el, 'onClick')?.value as (Node & { end: number }) | undefined;
      if (click && source.slice(click.start, click.end).includes('navigate(')) out.push(`${at(el)} <${name}>`);
    }
  });
  return out;
}

/** Every .tsx under `dir` (tests aside), but blocks.tsx. */
function scan(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const file = path.join(e.parentPath, e.name);
    if (e.isFile() && file.endsWith('.tsx') && !file.endsWith('.test.tsx') && file !== ALLOWED) out.push(...backLinks(path.relative(SRC, file), readFileSync(file, 'utf8')));
  }
  return out;
}

describe('one way back', () => {
  it('no back link outside blocks.tsx', () => {
    expect(scan(SRC)).toEqual([]);
  });

  it('finds a planted link and a planted navigating button (negative control)', () => {
    // A level down, as a feature file is: the scan walks the tree.
    const dir = mkdtempSync(path.join(tmpdir(), 'backlinks-'));
    mkdirSync(path.join(dir, 'features'));
    writeFileSync(
      path.join(dir, 'features', 'Planted.tsx'),
      [
        'export const A = () => <Link to="/data"><Icon name="arrow-left" /><span>Data</span></Link>;',
        'export const B = () => <Button icon="chevron-left" onClick={() => void navigate(`/visuals`)}>Back</Button>;',
        // Not back links: a wizard step back, and a pager.
        'export const C = () => <Button icon="chevron-left" onClick={() => setStep(1)}>Back</Button>;',
        'export const D = () => <IconButton icon="chevron-left" label="Previous page" onClick={() => go(-1)} />;',
      ].join('\n'),
    );
    expect(scan(dir).map((f) => f.replace(/^.*Planted/, 'Planted'))).toEqual(['Planted.tsx:1 <Link>', 'Planted.tsx:2 <Button>']);
  });

  it('would see the one it allows: blocks.tsx draws the crumb', () => {
    expect(backLinks('app/blocks.tsx', readFileSync(ALLOWED, 'utf8'))).toHaveLength(1);
  });
});
