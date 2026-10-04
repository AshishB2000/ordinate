import { describe, expect, it } from 'vitest';
import { columnsBefore, guessKeys, joinsOf, keptIndexes, mappingSteps, missingKey, retypeOf, withCell, type ChainTable, type Link } from './composerModel';
import type { GridColumn } from '../../ui/DataGrid/DataGrid';

const cols: GridColumn[] = [
  { name: 'zip', type: 'text' },
  { name: 'amount', type: 'number' },
  { name: 'label', type: 'text' },
];
const table = (label: string, columns: string[], id = label): ChainTable => ({ label, rows: 1, kind: 'csv', ref: { datasetId: id }, columns });

describe('composer model', () => {
  it('guesses a join key by exact name, then ignoring case, else leaves it blank', () => {
    expect(guessKeys(['region', 'amount'], ['x', 'region'])).toEqual({ left: 'region', right: 'region' });
    expect(guessKeys(['Region'], ['region'])).toEqual({ left: 'Region', right: 'region' });
    expect(guessKeys(['a'], ['b'])).toBeUndefined();
  });

  it('offers the columns left of each link: the base, then the union of what came before', () => {
    const base = table('base', ['id', 'a']);
    const links: Link[] = [
      { table: table('t1', ['id', 'b']), mode: 'inner', on: { left: 'id', right: 'id' } },
      { table: table('t2', ['c']), mode: 'append' },
    ];
    expect(columnsBefore(base, links, 0, [])).toEqual(['id', 'a']);
    expect(columnsBefore(base, links, 1, [])).toEqual(['id', 'a', 'b']);
    // The last link takes the preview's own columns when there are some.
    expect(columnsBefore(base, links, 1, [{ name: 'id', type: 'text' }, { name: 'b_1', type: 'text' }])).toEqual(['id', 'b_1']);
  });

  it('a join without a key is missing one; an append never is', () => {
    expect(missingKey({ table: table('t', []), mode: 'inner' })).toBe(true);
    expect(missingKey({ table: table('t', []), mode: 'append' })).toBe(false);
    expect(joinsOf([{ table: table('t', [], 'id-1'), mode: 'left', on: { left: 'a', right: 'b' } }])).toEqual([
      { datasetId: 'id-1', mode: 'left', on: { left: 'a', right: 'b' } },
    ]);
  });

  it('the mapping saves as prepare steps: renames first, drops by original name', () => {
    const map = {
      zip: { name: 'postcode', type: 'text' as const, dropped: false },
      label: { name: 'note', type: 'text' as const, dropped: true },
    };
    expect(mappingSteps(cols, map)).toEqual([
      { type: 'rename_column', from: 'zip', to: 'postcode' },
      { type: 'drop_column', column: 'label' },
    ]);
    expect(keptIndexes(cols, map)).toEqual([0, 1]);
    expect(retypeOf(cols, map)).toBeUndefined(); // no type changed
    expect(retypeOf(cols, { amount: { name: 'amount', type: 'text', dropped: false } })).toEqual([
      { name: 'zip', type: 'text' },
      { name: 'amount', type: 'text' },
      { name: 'label', type: 'text' },
    ]);
  });

  it('a corrected cell lands in a copy of the inline rows, never in a saved dataset', () => {
    const ref = { inline: { name: 'cap', columns: cols, rows: [['1', 2, 'a']] } };
    const next = withCell(ref, 0, 1, '20');
    expect(next).toEqual({ inline: { name: 'cap', columns: cols, rows: [['1', '20', 'a']] } });
    expect(ref.inline.rows[0][1]).toBe(2);
    expect(withCell({ datasetId: 'x' }, 0, 0, 'v')).toBeNull();
  });
});
