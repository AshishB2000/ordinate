import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { asOfView, OLD_AFTER_MS } from './asOf';
import { AsOfCaption } from './AsOf';

// Pinned clock, locale and zone: the words must not depend on where the test runs.
const NOW = Date.parse('2026-10-09T02:08:00Z');
const O = { now: NOW, locale: 'en-US', timeZone: 'UTC' };
const AT_1AM = '2026-10-09T01:00:00.000Z';

describe('asOfView — every variant a phase will send', () => {
  it('an extract: "As of" its time today, muted', () => {
    expect(asOfView({ at: AT_1AM, mode: 'extract' }, O)).toEqual({ text: 'As of 1:00 AM', tone: 'muted', title: 'Data as of Friday, October 9, 2026 at 1:00 AM' });
  });

  it('live, just asked: "Live ·" its time', () => {
    expect(asOfView({ at: '2026-10-09T02:05:00Z', mode: 'live' }, O)?.text).toBe('Live · 2:05 AM');
  });

  it('live, from the cache: how long ago', () => {
    expect(asOfView({ at: '2026-10-09T02:05:00Z', mode: 'live', cached: true }, O)?.text).toBe('Live · cached 3 min ago');
    expect(asOfView({ at: '2026-10-09T02:07:40Z', mode: 'live', cached: true }, O)?.text).toBe('Live · cached just now');
    expect(asOfView({ at: '2026-10-08T23:08:00Z', mode: 'live', cached: true }, O)?.text).toBe('Live · cached 3 h ago');
  });

  it('stale: says so, and takes the warning tint even when recent', () => {
    const v = asOfView({ at: AT_1AM, mode: 'live', stale: true }, O);
    expect(v?.text).toBe('Stale · as of 1:00 AM');
    expect(v?.tone).toBe('warn');
    expect(v?.title).toMatch(/could not be reached/);
  });

  it('refreshing: the figure stands, with a note that a newer one is coming', () => {
    expect(asOfView({ at: AT_1AM, mode: 'extract', refreshing: true }, O)?.text).toBe('As of 1:00 AM · refreshing…');
  });

  it('another day names the date; another year the year', () => {
    expect(asOfView({ at: '2026-10-08T23:00:00Z', mode: 'extract' }, O)?.text).toBe('As of Oct 8, 11:00 PM');
    expect(asOfView({ at: '2025-12-31T09:30:00Z', mode: 'extract' }, O)?.text).toBe('As of Dec 31, 2025, 9:30 AM');
  });

  it('in the reader\'s zone: the same instant reads as their wall clock', () => {
    expect(asOfView({ at: AT_1AM, mode: 'extract' }, { ...O, timeZone: 'America/Los_Angeles' })?.text).toBe('As of 6:00 PM');
    expect(asOfView({ at: AT_1AM, mode: 'extract' }, { ...O, timeZone: 'Asia/Tokyo' })?.text).toBe('As of 10:00 AM');
    expect(asOfView({ at: '2026-10-08T14:00:00Z', mode: 'extract' }, { ...O, timeZone: 'Asia/Tokyo' })?.text).toBe('As of Oct 8, 11:00 PM');
  });

  it('more than a day old takes the warning tint; a day exactly does not', () => {
    const day = new Date(NOW - OLD_AFTER_MS).toISOString();
    const older = new Date(NOW - OLD_AFTER_MS - 60_000).toISOString();
    expect(asOfView({ at: day, mode: 'extract' }, O)?.tone).toBe('muted');
    const v = asOfView({ at: older, mode: 'extract' }, O);
    expect(v?.tone).toBe('warn');
    expect(v?.title).toMatch(/more than a day old/);
  });

  it('no time, or one that does not parse, shows nothing rather than a guess', () => {
    expect(asOfView(undefined, O)).toBeNull();
    expect(asOfView(null, O)).toBeNull();
    expect(asOfView({ at: 'yesterday', mode: 'extract' }, O)).toBeNull();
  });
});

describe('AsOfCaption', () => {
  it('a <time> with the server\'s instant, the words, and the full time on hover', () => {
    render(<AsOfCaption asOf={{ at: new Date().toISOString(), mode: 'extract' }} />);
    const el = screen.getByTestId('as-of');
    expect(el.tagName).toBe('TIME');
    expect(el.textContent).toMatch(/^As of /);
    expect(el.getAttribute('title')).toMatch(/^Data as of /);
    expect(el.querySelector('svg')).toBeNull();
  });

  it('an old figure carries an icon as well as the tint — never colour alone', () => {
    render(<AsOfCaption asOf={{ at: '2020-01-01T00:00:00Z', mode: 'extract' }} />);
    expect(screen.getByTestId('as-of').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders nothing without an asOf', () => {
    const { container } = render(<AsOfCaption asOf={undefined} />);
    expect(container.textContent).toBe('');
  });
});
