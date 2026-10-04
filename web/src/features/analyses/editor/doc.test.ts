// The editor's document: undo / redo, keystroke coalescing, no-op edits, and
// the control → filter-step rules (dashboardFilters.ts controlSteps).

import { describe, expect, it } from 'vitest';
import { buildParam } from '../ParamDialog';
import { COALESCE_MS, initial, reduce, type Doc } from './doc';
import { controlSteps, substitute } from './filters';

const doc = (): Doc => ({ name: 'D', sheets: [{ id: 's', name: 'Sheet 1', cards: [] }], filters: [], parameters: [] });

describe('undo / redo', () => {
  it('each edit is a step; undo and redo walk them; a new edit drops the redo', () => {
    let h = initial(doc());
    h = reduce(h, { type: 'edit', label: 'Rename', mutate: (d) => void (d.name = 'A') });
    h = reduce(h, { type: 'edit', label: 'Rename', mutate: (d) => void (d.name = 'B') });
    expect(h.doc.name).toBe('B');
    expect(h.past.map((p) => p.label)).toEqual(['Rename', 'Rename']);
    h = reduce(h, { type: 'undo' });
    expect(h.doc.name).toBe('A');
    h = reduce(h, { type: 'redo' });
    expect(h.doc.name).toBe('B');
    h = reduce(h, { type: 'undo' });
    h = reduce(h, { type: 'edit', label: 'Rename', mutate: (d) => void (d.name = 'C') });
    expect(h.future).toEqual([]);
    expect(reduce(h, { type: 'redo' })).toBe(h);
  });

  it('typing in one field within a second is ONE step', () => {
    let h = initial(doc());
    h = reduce(h, { type: 'edit', label: 'Edit text', coalesce: true, now: 1000, mutate: (d) => void (d.name = 'H') });
    h = reduce(h, { type: 'edit', label: 'Edit text', coalesce: true, now: 1200, mutate: (d) => void (d.name = 'He') });
    h = reduce(h, { type: 'edit', label: 'Edit text', coalesce: true, now: 1200 + COALESCE_MS + 1, mutate: (d) => void (d.name = 'Hey') });
    expect(h.past.length).toBe(2);
    expect(reduce(h, { type: 'undo' }).doc.name).toBe('He');
  });

  it('an edit that changes nothing is not a step and does not trigger a save', () => {
    const h = initial(doc());
    expect(reduce(h, { type: 'edit', label: 'Nothing', mutate: () => undefined })).toBe(h);
  });

  it('the edit works on a copy: the previous document is untouched', () => {
    const h0 = initial(doc());
    const h1 = reduce(h0, { type: 'edit', label: 'Add', mutate: (d) => void d.sheets[0].cards.push({ id: 'c', type: 'text', layout: { x: 0, y: 0, w: 1, h: 1 }, text: 'x' }) });
    expect(h0.doc.sheets[0].cards).toEqual([]);
    expect(h1.version).toBe(1);
  });
});

describe('controls and parameters', () => {
  const ctl = (kind: 'dropdown' | 'multi' | 'date_range') => ({ kind, label: '', datasetId: 'd', column: 'region' });
  it('an unset or empty selection filters nothing', () => {
    expect(controlSteps(ctl('dropdown'), undefined)).toEqual([]);
    expect(controlSteps(ctl('dropdown'), { value: '' })).toEqual([]);
    expect(controlSteps(ctl('multi'), { values: [] })).toEqual([]);
    expect(controlSteps(ctl('date_range'), {})).toEqual([]);
  });
  it('a selection is one filter step of the server shape', () => {
    expect(controlSteps(ctl('dropdown'), { value: 'East' })).toEqual([{ type: 'filter', column: 'region', op: '=', value: 'East' }]);
    expect(controlSteps(ctl('multi'), { values: ['E', 'W'] })).toEqual([{ type: 'filter', column: 'region', op: 'in', values: ['E', 'W'] }]);
    expect(controlSteps(ctl('date_range'), { from: '2024-01-01' })).toEqual([{ type: 'filter', column: 'region', op: 'period', period: { preset: 'custom', from: '2024-01-01' } }]);
  });
  it('{{name}} shows a value; an unknown name stays as typed', () => {
    const p = [{ name: 'min', kind: 'number', value: 2500.5 }];
    expect(substitute('Over {{ min }} and {{max}}', p)).toBe('Over 2,500.5 and {{max}}');
  });
  it('the parameter dialog refuses what the server would quietly correct', () => {
    const f = { name: 'min', kind: 'number' as const, value: '5', min: '0', max: '10', step: '1', options: '' };
    const none = () => false;
    expect(buildParam(f, none).param).toEqual({ name: 'min', kind: 'number', value: 5, min: 0, max: 10, step: 1 });
    expect(buildParam({ ...f, name: '2x' }, none).error).toMatch(/starts with a letter/);
    expect(buildParam({ ...f, min: '20' }, none).error).toMatch(/minimum is above/);
    expect(buildParam({ ...f, value: '50' }, none).error).toMatch(/outside the bounds/);
    expect(buildParam({ ...f, step: '0' }, none).error).toMatch(/above zero/);
    expect(buildParam(f, () => true).error).toMatch(/already has a parameter/);
    expect(buildParam({ ...f, kind: 'text', value: 'x', options: 'a\nb' }, none).error).toMatch(/not one of the options/);
    expect(buildParam({ ...f, kind: 'list', value: 'West, East', options: '' }, none).param).toEqual({ name: 'min', kind: 'list', value: ['West', 'East'] });
  });
});
