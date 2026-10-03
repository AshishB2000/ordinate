// The states a map shows before (or instead of) MapLibre — jsdom has no
// WebGL, which is exactly the "this map needs WebGL" path — and the radius
// editor's resolve-then-apply flow against a stubbed server. Drawing itself is
// geo.test.ts (differential) and web/e2e/maps.e2e.ts (a real browser).

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { encode } from '../../../../src/server/wire.ts';
import { MapView } from './MapView';
import { RadiusEditor } from './RadiusEditor';
import { radiusSentence, radiusSteps } from './radius';
import type { MapData } from './types';

const region: MapData = { labels: ['Texas'], series: [{ name: 'Profit', values: [5] }], geo: { level: 'us_state', items: [{ name: 'Texas', value: 5 }] } };

describe('<MapView>', () => {
  // jsdom has no canvas contexts at all (and logs "not implemented"): say so quietly.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;

  it('says there is nothing to map when the reply has no geography', async () => {
    render(<MapView data={{ labels: [], series: [] }} chartType="map_choropleth" label="Profit by state" />);
    expect(await screen.findByRole('heading', { name: 'Nothing to map' })).toBeTruthy();
    expect(screen.getByRole('figure', { name: 'Profit by state' }).getAttribute('aria-busy')).toBe('false');
  });

  it('says it needs WebGL where there is none, instead of a blank box', async () => {
    render(<MapView data={region} chartType="map_choropleth" label="Profit by state" />);
    expect(await screen.findByRole('heading', { name: 'This map needs WebGL' })).toBeTruthy();
    expect(screen.getByRole('figure').getAttribute('data-map-status')).toBe('nowebgl');
  });
});

describe('the radius control', () => {
  it('is a sentence and one within_km step, or nothing while unset', () => {
    expect(radiusSentence(25, 'Austin, TX')).toBe('within 25 km of Austin, TX');
    expect(radiusSentence(2.25, 'X')).toBe('within 2.3 km of X');
    expect(radiusSteps({ column: 'lat', lngColumn: 'lon' }, null)).toEqual([]);
    expect(radiusSteps({ column: 'lat' }, { value: 'v', lat: 1, lng: 2, km: 5 })).toEqual([]);
    expect(radiusSteps({ column: 'lat', lngColumn: 'lon' }, { value: 'v', place: 'P', lat: 1, lng: 2, km: 5 })).toEqual([
      { type: 'filter', column: 'lat', op: 'within_km', radius: { lngColumn: 'lon', lat: 1, lng: 2, km: 5, place: 'P' } },
    ]);
  });

  it('shows the resolved place before it applies, and applies nothing for an unknown one', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn(async (_url: string, init: { body: string }) => {
      const text = (JSON.parse(init.body) as { args: [{ text: string }] }).args[0].text;
      const reply = text === 'Austin' ? { ok: true, place: { label: 'Austin, TX', lat: 30.2672, lng: -97.7431 } } : { ok: false, error: `No place called "${text}" in the offline places table.` };
      return new Response(encode(reply), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const onChange = vi.fn();
    render(<RadiusEditor onChange={onChange} />);
    expect(screen.getByText('Type a place to measure from.')).toBeTruthy();
    const place = screen.getByRole('textbox', { name: 'Place' });

    fireEvent.change(place, { target: { value: 'Atlantis' } });
    expect(screen.getByText('Looking up “Atlantis”…')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.getByText('No place called "Atlantis" in the offline places table.')).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith(null);

    fireEvent.change(place, { target: { value: 'Austin' } });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.getByText('Austin, TX · 30.267, -97.743')).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith({ value: 'within 25 km of Austin, TX', place: 'Austin, TX', lat: 30.2672, lng: -97.7431, km: 25 });

    fireEvent.click(screen.getByRole('button', { name: '50 km' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ km: 50, value: 'within 50 km of Austin, TX' }));
    expect(fetchSpy).toHaveBeenCalledTimes(2); // debounced: one lookup per settled word
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
