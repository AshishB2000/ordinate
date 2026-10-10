import { describe, expect, it } from 'vitest';
import { RpcError } from '../../api/client';
import { cacheAgeOptions, CACHE_AGES } from '../data/LiveSettings';
import { sampleLine, syncWords } from '../data/SchemaPanel';
import { chartFeature, LIVE_OFF, LIVE_OFF_CHARTS, LIVE_OFF_LIST } from './offFeatures';
import { LIVE_OFF_FALLBACK, LiveRefusalError, liveRefusalOf, replyError } from './refusal';

const SENTENCE = 'This is a Live dataset — this isn’t available on Live yet. Make a copy to use it.';
const PIVOT = 'A pivot table cannot be drawn from a Live dataset yet.';

describe('liveRefusalOf — one reading of every "off for Live" shape', () => {
  it('a handler reply, typed by the route (D6)', () => {
    expect(liveRefusalOf({ ok: false, error: SENTENCE, code: 'live_dataset' })).toBe(SENTENCE);
  });
  it("the chart adapter's live_refused: the sentence, never the reason CODE", () => {
    expect(liveRefusalOf({ ok: false, code: 'live_refused', reason: 'pivot', error: PIVOT })).toBe(PIVOT);
  });
  it("an answer card's refusal carries its sentence in `reason`", () => {
    expect(liveRefusalOf({ ok: false, code: 'live_dataset', reason: SENTENCE })).toBe(SENTENCE);
  });
  it('the route’s 409, thrown as an RpcError', () => {
    expect(liveRefusalOf(new RpcError(409, 'live_dataset', SENTENCE))).toBe(SENTENCE);
  });
  it('a LiveRefusalError a hook threw', () => {
    expect(liveRefusalOf(new LiveRefusalError('live_refused', PIVOT))).toBe(PIVOT);
  });
  it('a refusal without words reads as the catalog’s', () => {
    expect(liveRefusalOf({ ok: false, code: 'live_refused', reason: 'pivot' })).toBe(LIVE_OFF_FALLBACK);
  });
  it('NEGATIVE CONTROLS: an ordinary failure, a warehouse failure, a success, nothing — not a refusal', () => {
    expect(liveRefusalOf({ ok: false, error: 'Dataset not found' })).toBeNull();
    expect(liveRefusalOf({ ok: false, code: 'live_failed', error: 'The warehouse could not answer this.' })).toBeNull();
    expect(liveRefusalOf({ ok: false, code: 'live_timeout', error: 'Took too long.' })).toBeNull();
    expect(liveRefusalOf({ ok: true, code: 'live_dataset' })).toBeNull();
    expect(liveRefusalOf(new RpcError(500, 'handler failed', 'handler failed'))).toBeNull();
    expect(liveRefusalOf(new Error(SENTENCE))).toBeNull();
    expect(liveRefusalOf(null)).toBeNull();
    expect(liveRefusalOf('live_dataset')).toBeNull();
  });
});

describe('replyError', () => {
  it('keeps an "off for Live" code, so the screen can offer a copy', () => {
    const e = replyError({ ok: false, code: 'live_dataset', error: SENTENCE }, 'Could not compute the visual.');
    expect(e).toBeInstanceOf(LiveRefusalError);
    expect(e.message).toBe(SENTENCE);
    expect(liveRefusalOf(e)).toBe(SENTENCE);
  });
  it('NEGATIVE CONTROL: any other failure is a plain Error with its words or the fallback', () => {
    const e = replyError({ ok: false, error: 'Pick a measure.' }, 'Could not compute the visual.');
    expect(e).not.toBeInstanceOf(LiveRefusalError);
    expect(e.message).toBe('Pick a measure.');
    expect(replyError({ ok: false }, 'Could not compute the visual.').message).toBe('Could not compute the visual.');
    expect(liveRefusalOf(e)).toBeNull();
  });
});

describe('a refusal’s machine reason', () => {
  it('is kept beside the sentence, so a picker can tell "not synced yet" from "not listed"', () => {
    const e = replyError({ ok: false, code: 'live_refused', reason: 'notSynced', error: 'Not synced yet.' }, 'x');
    expect(e).toBeInstanceOf(LiveRefusalError);
    expect((e as LiveRefusalError).reason).toBe('notSynced');
    expect(e.message).toBe('Not synced yet.');
  });
  it('NEGATIVE CONTROL: a sentence in `reason` (an answer card) is the message, never a reason code', () => {
    const e = replyError({ ok: false, code: 'live_dataset', reason: SENTENCE }, 'x') as LiveRefusalError;
    expect(e.message).toBe(SENTENCE);
    expect(e.reason).toBeUndefined();
  });
});

describe('what is off for Live (the plan’s list)', () => {
  it('names the six groups of L2.6, and words every feature with a place to open the copy', () => {
    expect(LIVE_OFF_LIST).toHaveLength(6);
    for (const [key, w] of Object.entries(LIVE_OFF)) {
      expect(w.title, key).toMatch(/Live datasets$/);
      expect(w.why.length, key).toBeGreaterThan(20);
      expect(w.open('p', 'c'), key).toMatch(/^\/(data|analytics|visuals)\//);
    }
    expect(LIVE_OFF.prepare.open('p', 'c')).toBe('/data/p/c/prepare');
    expect(LIVE_OFF.quality.open('p', 'c')).toBe('/data/p/c?tab=quality');
    expect(LIVE_OFF.stats.open('p', 'c')).toBe('/analytics/p/c/stats');
  });
  it('the grid engines are off; an ordinary chart is not', () => {
    expect([...LIVE_OFF_CHARTS].sort()).toEqual(['cohort', 'event_funnel', 'pivot']);
    expect(chartFeature('pivot')).toBe('pivot');
    expect(chartFeature('column')).toBeNull();
  });
});

describe('the cache-age picker', () => {
  it('offers the plan’s six ages, 5 min marked the default', () => {
    expect(CACHE_AGES.map((a) => a.label)).toEqual(['Always live', '1 min', '5 min (default)', '1 h', '6 h', '1 day']);
    expect(cacheAgeOptions(300).map((o) => o.value)).toEqual(['0', '60', '300', '3600', '21600', '86400']);
  });
  it('an age set another way (the API) is shown in its place, never replaced', () => {
    const opts = cacheAgeOptions(600);
    expect(opts.map((o) => o.value)).toEqual(['0', '60', '300', '600', '3600', '21600', '86400']);
    expect(opts.find((o) => o.value === '600')?.label).toBe('10 min');
  });
});

describe('the Schema panel’s words', () => {
  it('says the figures are a sample’s, and how big', () => {
    expect(sampleLine({ sampledAt: '2026-10-09T19:12:00Z', sampleRows: 240, method: 'sample' })).toMatch(/^Profiled from a sample of 240 rows · /);
    expect(sampleLine({ sampledAt: '2026-10-09T19:12:00Z', sampleRows: 1000, method: 'limit' })).toMatch(/the first rows/);
    expect(sampleLine({ sampledAt: null, sampleRows: null, method: null })).toMatch(/^Not profiled yet/);
  });
  it('words a sync: what changed, the sample, or the server’s refusal', () => {
    expect(syncWords({ ok: true, status: 'synced', columns: 3, added: ['note'], removed: [], retyped: [], missing: [], sample: { ok: true, rows: 240 } }).text)
      .toBe('Synced 3 columns — added note. Profiled from 240 rows.');
    const skipped = syncWords({ ok: true, status: 'synced', columns: 1, added: [], removed: [], retyped: [], missing: [], sample: { ok: false, error: 'The sample would cost too much, so the last figures are kept.' } });
    expect(skipped).toEqual({ text: 'Synced 1 column. The sample would cost too much, so the last figures are kept.', error: true });
    expect(syncWords({ ok: false, error: 'The warehouse could not be read.' })).toEqual({ text: 'The warehouse could not be read.', error: true });
    expect(syncWords({ ok: true, status: 'already_running', message: 'A sync is already running.' }).text).toBe('A sync is already running.');
  });
});
