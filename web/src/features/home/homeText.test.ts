import { describe, expect, it } from 'vitest';
import { displayName, greeting, itemHref, metaText, qualityLabel, suggestPrompts, SAMPLE_DATASET } from './homeText';

describe('home words', () => {
  it('greets by the email\'s first name, by the time of day, and nobody without one', () => {
    expect(displayName('ana.ruiz@corp.example')).toBe('Ana');
    expect(displayName('dev@local')).toBe('Dev');
    expect(displayName(undefined)).toBe('');
    expect(greeting('Ana', 4)).toBe('Good to see you, Ana');
    expect(greeting('Ana', 5)).toBe('Good morning, Ana');
    expect(greeting('Ana', 12)).toBe('Good afternoon, Ana');
    expect(greeting('Ana', 17)).toBe('Good evening, Ana');
    expect(greeting('Ana', 22)).toBe('Good to see you, Ana');
    expect(greeting('', 9)).toBe('Welcome back');
  });

  it('says what a row is, from the counts the server sent, or nothing', () => {
    expect(metaText({ type: 'dataset', meta: { rowCount: 1240, columnCount: 1 } })).toBe(`${(1240).toLocaleString()} rows × 1 column`);
    expect(metaText({ type: 'analysis', meta: { sheetCount: 1 } })).toBe('1 sheet');
    expect(metaText({ type: 'dataset' })).toBe('');
    expect(metaText({ type: 'capture', meta: { rowCount: 3 } })).toBe('');
    expect(qualityLabel(2)).toBe('Data quality: 2 rules failing');
    expect(qualityLabel(0)).toBe('');
  });

  it('suggests from the project’s real datasets, building only for an editor, each pointing at the one it names', () => {
    const O = { id: 'o', name: 'Orders' };
    const R = { id: 'r', name: 'Returns' };
    const texts = (ds: Array<{ id: string; name: string }>, canEdit = true) => suggestPrompts(ds, canEdit).map((p) => p.text);
    expect(texts([O, R, { id: 's', name: 'Stock' }])).toEqual(['Build a dashboard from Orders', 'Clean up Orders', 'Summarise Orders', 'What is in Returns?']);
    expect(texts([O])).toEqual(['Build a dashboard from Orders', 'Clean up Orders', 'Summarise Orders']);
    // A viewer is offered only what reads.
    expect(texts([O, R], false)).toEqual(['Summarise Orders', 'What is in Returns?']);
    const sample = { id: 'x', name: SAMPLE_DATASET };
    expect(texts([sample])).toEqual(['Which region had the worst month in Retail orders?', 'Chart revenue by category in Retail orders', 'Build a dashboard from Retail orders']);
    expect(texts([sample], false)).toEqual(['Which region had the worst month in Retail orders?', 'Chart revenue by category in Retail orders']);
    expect(texts([])).toEqual([]);
    expect(texts([{ id: 'b', name: '  ' }])).toEqual([]);
    // Each one is about the dataset its sentence names.
    const all = suggestPrompts([O, R], true);
    expect(all.map((p) => p.about.id)).toEqual(['o', 'o', 'o', 'r']);
    for (const p of all) expect(p.text).toContain(p.about.name);
    expect(all.map((p) => p.icon)).toEqual(['layout-dashboard', 'filter', 'file-text', 'table']);
  });

  it('opens a dataset, a dashboard and a visual on their own page and the rest on their section', () => {
    expect(itemHref({ type: 'dataset', id: 'd', projectId: 'p' })).toBe('/data/p/d');
    expect(itemHref({ type: 'analysis', id: 'a', projectId: 'p' })).toBe('/analyses/p/a');
    expect(itemHref({ type: 'visual', id: 'v', projectId: 'p' })).toBe('/visuals/p/v');
    expect(itemHref({ type: 'report', id: 'r', projectId: 'p' })).toBe('/reports');
    expect(itemHref({ type: 'capture', id: 'c', projectId: 'p' })).toBe('/data');
  });
});
