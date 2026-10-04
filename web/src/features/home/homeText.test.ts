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

  it('suggests from real dataset names, the sample\'s own questions, or nothing', () => {
    expect(suggestPrompts(['Orders', 'Returns', 'Stock'], [])).toEqual([
      'What stands out in Orders?',
      'How do Orders and Returns compare?',
      'Summarise Orders in plain terms',
    ]);
    expect(suggestPrompts(['Orders'], [])).toEqual(['What stands out in Orders?', 'Summarise Orders in plain terms']);
    expect(suggestPrompts([SAMPLE_DATASET], [])).toEqual(['Which region had the worst month?', 'Revenue by category this year']);
    expect(suggestPrompts([], [SAMPLE_DATASET])).toEqual(['Which region had the worst month?', 'Revenue by category this year']);
    expect(suggestPrompts([], ['Orders'])).toEqual([]);
  });

  it('opens a dataset on its page and every other record on its section', () => {
    expect(itemHref({ type: 'dataset', id: 'd', projectId: 'p' })).toBe('/data/p/d');
    expect(itemHref({ type: 'analysis', id: 'a', projectId: 'p' })).toBe('/dashboards');
    expect(itemHref({ type: 'report', id: 'r', projectId: 'p' })).toBe('/reports');
    expect(itemHref({ type: 'capture', id: 'c', projectId: 'p' })).toBe('/data');
  });
});
