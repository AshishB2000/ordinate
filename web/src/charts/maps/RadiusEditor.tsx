// The radius control's editor — "Within [25] km of [place]", the preset
// distances, and the place the server resolved, SHOWN before it filters
// (geoRadius.ts radiusEditor). Shared by the dashboard chip's popover and the
// add/edit dialog when dashboards port (T2.x). A place the offline table does
// not know applies nothing and says so.

import { useEffect, useRef, useState } from 'react';
import { rpc } from '../../api/client';
import { Icon } from '../../ui/icons/Icon';
import { MAX_KM, RADIUS_PRESETS, radiusSentence, type RadiusState } from './radius';
import s from './RadiusEditor.module.css';

interface Place {
  label: string;
  lat: number;
  lng: number;
}
type Match = { kind: 'idle' } | { kind: 'looking'; text: string } | { kind: 'ok'; place: Place } | { kind: 'err'; message: string };

const where = (p: Place) => `${p.label} · ${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}`;

export function RadiusEditor({ seed, onChange }: { seed?: Partial<RadiusState> | null; onChange: (v: RadiusState | null) => void }) {
  const [km, setKm] = useState(String(seed && (seed.km ?? 0) > 0 ? seed.km : 25));
  const [text, setText] = useState(seed?.place ? String(seed.place) : '');
  const [match, setMatch] = useState<Match>(() =>
    seed && typeof seed.lat === 'number' && typeof seed.lng === 'number' ? { kind: 'ok', place: { label: seed.place || '', lat: seed.lat, lng: seed.lng } } : { kind: 'idle' },
  );
  const seq = useRef(0);
  const report = useRef(onChange);
  useEffect(() => {
    report.current = onChange;
  });

  // Look the place up 250 ms after the last keystroke; a newer lookup wins.
  const lookup = (value: string) => {
    setText(value);
    const mine = ++seq.current;
    const t = value.trim();
    if (!t) return setMatch({ kind: 'idle' });
    setMatch({ kind: 'looking', text: t });
    setTimeout(() => {
      if (mine !== seq.current) return;
      rpc('geo:resolvePlace', { text: t }).then(
        (res) => {
          if (mine !== seq.current) return;
          const r = res as { ok: boolean; place?: Place; error?: string };
          setMatch(r.ok && r.place ? { kind: 'ok', place: r.place } : { kind: 'err', message: r.error || 'That place could not be looked up.' });
        },
        () => mine === seq.current && setMatch({ kind: 'err', message: 'That place could not be looked up.' }),
      );
    }, 250);
  };

  const k = Number(km);
  useEffect(() => {
    const good = match.kind === 'ok' && k > 0 && k <= MAX_KM;
    report.current(good ? { value: radiusSentence(k, match.place.label), place: match.place.label, lat: match.place.lat, lng: match.place.lng, km: k } : null);
  }, [match, k]);

  return (
    <div className={s.editor}>
      <div className={s.row}>
        <span className={s.word}>Within</span>
        <input
          className={`${s.input} ${s.km}`}
          type="number"
          min="0.1"
          max={MAX_KM}
          step="any"
          aria-label="Distance in kilometres"
          value={km}
          onChange={(e) => setKm(e.target.value)}
        />
        <span className={s.word}>km of</span>
        <input
          className={`${s.input} ${s.place}`}
          type="text"
          placeholder="City, county or ZIP — e.g. Austin, TX"
          aria-label="Place"
          value={text}
          onChange={(e) => lookup(e.target.value)}
        />
      </div>
      <div className={s.presets} role="group" aria-label="Common distances">
        {RADIUS_PRESETS.map((n) => (
          <button key={n} type="button" className={k === n ? `${s.preset} ${s.on}` : s.preset} aria-pressed={k === n} onClick={() => setKm(String(n))}>
            {n} km
          </button>
        ))}
      </div>
      <div className={[s.match, match.kind === 'ok' && s.ok, match.kind === 'err' && s.err].filter(Boolean).join(' ')} aria-live="polite">
        {match.kind === 'ok' && <Icon name="map-pin" size={12} />}
        <span>
          {match.kind === 'idle' && 'Type a place to measure from.'}
          {match.kind === 'looking' && `Looking up “${match.text}”…`}
          {match.kind === 'ok' && where(match.place)}
          {match.kind === 'err' && match.message}
        </span>
      </div>
    </div>
  );
}
