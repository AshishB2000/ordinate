// The pure edits behind the builder, the story page and the scorecard editor:
// pages that are settings (Narrative, Discussion last), caption overrides,
// the story undo stack with keystroke coalescing, the always-empty tail line,
// and a scorecard row's edit form round trip.

import { describe, expect, it } from 'vitest';
import type { Report, ReportPage, StoryBlock } from './api';
import { addPage, movePage, pageSubtitle, withCaption, withSettings } from './builder/model';
import { fromEditRow, toEditRow } from './scorecards/RowsEditor';
import { COALESCE_MS, historyNew, historyPush, historyRedo, historyUndo, redoLabel, undoLabel } from './stories/history';
import { filterPicks } from './stories/BlockPicker';
import { withTail } from './stories/StoryPage';

const page = (kind: ReportPage['kind'], extra: Partial<ReportPage> = {}): ReportPage => ({ id: kind + Math.random(), kind, include: true, layout: 'full', ...extra });
const report = (pages: ReportPage[]): Report => ({
  id: 'r', projectId: 'p', analysisId: 'a', name: 'R', format: 'pdf', pages, cover: { title: 'R' }, paper: { size: 'letter', orientation: 'portrait' },
  includeFilters: true, narrative: false, discussion: false, updatedAt: '',
});

describe('report settings that are pages', () => {
  it('Narrative adds its page and removes it again', () => {
    const on = withSettings(report([page('cover'), page('sheet')]), { narrative: true });
    expect(on.pages.map((p) => p.kind)).toEqual(['cover', 'sheet', 'narrative']);
    expect(withSettings(on, { narrative: false }).pages.map((p) => p.kind)).toEqual(['cover', 'sheet']);
  });
  it('Discussion is always the LAST page, kept (same id) when other settings change', () => {
    const on = withSettings(report([page('cover')]), { discussion: true });
    const id = on.pages[1].id;
    const both = withSettings(on, { narrative: true });
    expect(both.pages.map((p) => p.kind)).toEqual(['cover', 'narrative', 'discussion']);
    expect(both.pages[2].id).toBe(id);
  });
  it('pages move, are added at the end', () => {
    const ps = [page('cover'), page('summary'), page('sheet')];
    expect(movePage(ps, 2, 0).map((p) => p.kind)).toEqual(['sheet', 'cover', 'summary']);
    expect(movePage(ps, 0, 9)).toBe(ps);
    expect(addPage(ps, 'tile', 'c1').at(-1)).toMatchObject({ kind: 'tile', cardId: 'c1', include: true });
  });
  it('a caption override is stored only when it differs from the app’s sentence', () => {
    const p = page('tile');
    expect(withCaption(p, 'Mine', 'App').caption).toBe('Mine');
    expect(withCaption({ ...p, caption: 'Mine' }, 'App', 'App').caption).toBeUndefined();
    expect(withCaption({ ...p, caption: 'Mine' }, '  ', 'App').caption).toBeUndefined();
  });
  it('a page’s subtitle names its sheet or chart, or says it is gone', () => {
    const sheets = [{ name: 'Overview', cards: [{ id: 'c1', name: 'Sales by region' }] }];
    expect(pageSubtitle(page('sheet', { sheetIdx: 0 }), sheets)).toBe('Overview');
    expect(pageSubtitle(page('tile', { cardId: 'c1' }), sheets)).toBe('Sales by region');
    expect(pageSubtitle(page('tile', { cardId: 'zz' }), sheets)).toBe('No longer on the dashboard');
    expect(pageSubtitle(page('notes', { notes: '' }), sheets)).toBe('Empty');
  });
});

describe('story history', () => {
  it('keystrokes within the window coalesce; undo and redo walk the steps; a new edit drops redo', () => {
    let h = historyNew('a');
    h = historyPush(h, 'Edit text', 'ab', 1000, true);
    h = historyPush(h, 'Edit text', 'abc', 1000 + COALESCE_MS - 1, true);
    expect(h.past).toHaveLength(1);
    h = historyPush(h, 'Add block', 'abcX', 5000);
    expect(undoLabel(h)).toBe('Add block');
    const u = historyUndo(h)!;
    expect(u.h.present.snap).toBe('abc');
    expect(redoLabel(u.h)).toBe('Add block');
    expect(historyRedo(u.h)!.h.present.snap).toBe('abcX');
    expect(historyPush(u.h, 'Rename', 'Q', 9000).future).toHaveLength(0);
    expect(historyUndo(historyNew('x'))).toBeNull();
  });
});

describe('story blocks', () => {
  it('there is always an empty text line at the end to type into', () => {
    const chart: StoryBlock = { id: 'v', kind: 'visual', visualId: 'x', filters: [] };
    const tailed = withTail([chart]);
    expect(tailed).toHaveLength(2);
    expect(tailed[1]).toMatchObject({ kind: 'text', text: '' });
    expect(withTail(tailed)).toBe(tailed);
  });
  it('the slash picker filters by what follows the slash', () => {
    expect(filterPicks('/').length).toBe(8);
    expect(filterPicks('/met').map((p) => p.kind)).toEqual(['metric', 'metrics_row']);
    expect(filterPicks('/zzz')).toEqual([]);
  });
});

describe('scorecard rows', () => {
  it('the edit form round-trips a row; empty fields are dropped, numbers parsed', () => {
    const row = { metricId: 'm', target: 250, owner: 'Ana', group: 'Sales', thresholds: { good: 100, warn: 90 } };
    expect(fromEditRow(toEditRow(row))).toEqual(row);
    expect(fromEditRow(toEditRow({ metricId: 'm', target: { metricId: 't' } }))).toEqual({ metricId: 'm', target: { metricId: 't' } });
    expect(fromEditRow({ ...toEditRow({ metricId: 'm' }), targetMode: 'number', target: 'abc', good: '100', warn: '' })).toEqual({ metricId: 'm' });
  });
});
