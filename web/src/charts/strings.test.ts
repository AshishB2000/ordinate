// Every chart string is the desktop catalog's message, word for word, and
// renders through the same ICU formatter.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHART_STRINGS, t } from './strings';

// Vitest runs from web/; the catalog is the desktop's.
const EN = JSON.parse(readFileSync(path.resolve(process.cwd(), '..', 'src', 'i18n', 'en.json'), 'utf8')) as Record<string, string>;

describe('chart strings', () => {
  it('match src/i18n/en.json', () => {
    for (const [key, msg] of Object.entries(CHART_STRINGS)) expect(msg, key).toBe(EN[key]);
  });

  it('format plurals, selects and parameters', () => {
    expect(t('wordCloudRender.not_fit', { p0: '1', n: 1 })).toBe('1 smaller word did not fit');
    expect(t('wordCloudRender.not_fit', { p0: '3', n: 3 })).toBe('3 smaller words did not fit');
    expect(t('wordCloudRender.word_cloud', { p0: 'A 1', p1: true })).toBe('Word cloud: A 1, …');
    expect(t('chartRender.of_top', { v: '5K', pct: 40 })).toBe('5K (40% of top)');
  });
});
