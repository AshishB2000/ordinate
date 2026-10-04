// An open scenario's RESULTS (scenarioPage.ts): each metric's scenario value
// beside its baseline with the change, and a tornado of how far each driver
// moves one metric at ±10%. Every value, change, label and bar end comes from
// `scenario:compute`; the bars only place those numbers about the centre.

import { Icon } from '../../../ui/icons/Icon';
import { Select } from '../../../ui/Select';
import type { ScenarioFigure, ScenarioResult } from '../api';
import { fmtPct } from '../format';
import { TornadoArt } from './ScenarioParts';
import s from './ScenarioEditor.module.css';

function Kpi({ m, focused, onFocus }: { m: ScenarioFigure; focused: boolean; onFocus: () => void }) {
  const tone = m.delta === 0 || m.delta === null ? 'flat' : m.tone;
  return (
    <button
      type="button"
      className={m.missing ? `${s.kpi} ${s.isMissing}` : s.kpi}
      aria-pressed={focused}
      disabled={m.missing}
      title={m.missing ? 'This metric no longer exists' : `Show what moves ${m.name} in the sensitivity chart`}
      onClick={onFocus}
    >
      <span className={s.kpiName}>{m.name}</span>
      <span className={s.kpiValue}>{m.display || '—'}</span>
      <span className={s.kpiBase}>{`Baseline ${m.baselineDisplay || '—'}`}</span>
      <span className={`${s.kpiDelta} ${s[tone]}`}>
        {m.delta !== null && m.delta !== 0 && <Icon name={m.delta > 0 ? 'arrow-up' : 'arrow-down'} size={12} />}
        <span>{m.delta === null ? 'No figure' : m.delta === 0 ? 'No change' : m.deltaDisplay + (typeof m.pct === 'number' ? ` (${fmtPct(m.pct)})` : '')}</span>
      </span>
    </button>
  );
}

function Tornado({ res, onFocus }: { res: ScenarioResult; onFocus: (id: string) => void }) {
  const tv = res.tornado;
  const step = tv ? Math.round(tv.step * 100) : 10;
  const still = !!tv && tv.bars.length > 0 && tv.bars.every((b) => b.swing === 0);
  // The bars' half-width: the widest move either way from the scenario value. Placement only.
  const v = tv && typeof tv.value === 'number' ? tv.value : 0;
  let scale = 0;
  for (const b of tv?.bars ?? []) for (const x of [b.low, b.high]) if (typeof x === 'number') scale = Math.max(scale, Math.abs(x - v));
  const live = res.metrics.filter((m) => !m.missing);
  return (
    <section className={s.tornado} aria-labelledby="sn-tornado-h">
      <div className={s.tornadoHead}>
        <div>
          <h3 className={s.secH} id="sn-tornado-h">
            Sensitivity
          </h3>
          <p className={s.tornadoSub}>
            {tv
              ? `How far ${tv.name} (${tv.display}) moves when each driver's target moves ${step}% either way, the others as set. Widest first.`
              : 'Which driver matters most, once there is a metric with a figure.'}
          </p>
        </div>
        <div className={s.tornadoPick}>
          <Select
            size="sm"
            aria-label="Sensitivity of which metric"
            value={tv ? tv.metricId : null}
            disabled={!tv}
            options={live.map((m) => ({ value: m.metricId, label: m.name }))}
            onValueChange={onFocus}
          />
        </div>
      </div>
      {!tv || !tv.bars.length || still ? (
        <div className={s.tornadoEmpty}>
          <TornadoArt className={s.tornadoArt} />
          <p>
            {!tv
              ? 'Add a metric and a driver to see the sensitivity.'
              : still
                ? `None of these drivers moves ${tv.name}. Pick another metric above, or add a driver on one of its inputs.`
                : `Add a driver to see which one moves ${tv.name} most.`}
          </p>
        </div>
      ) : (
        <>
          <div className={`${s.torRow} ${s.torHead}`} aria-hidden="true">
            <span>Driver</span>
            <span className={s.torNum}>{`At −${step}%`}</span>
            <span className={s.torAxis}>{tv.display}</span>
            <span className={s.torNum}>{`At +${step}%`}</span>
          </div>
          {tv.bars.map((bar) => (
            <div
              key={bar.label}
              className={bar.swing === 0 ? `${s.torRow} ${s.isStill}` : s.torRow}
              role="img"
              aria-label={`${bar.label}: ${bar.lowDisplay} at −${step}%, ${bar.highDisplay} at +${step}%`}
            >
              <span className={s.torLabel} title={bar.label}>
                {bar.label}
              </span>
              <span className={s.torNum}>{bar.lowDisplay}</span>
              <span className={s.torTrack}>
                {(
                  [
                    [bar.low, s.torLow],
                    [bar.high, s.torHigh],
                  ] as Array<[number | null, string]>
                ).map(([x, cls]) =>
                  typeof x === 'number' && scale ? (
                    <span
                      key={cls}
                      className={`${s.torBar} ${cls}`}
                      style={{ left: `${50 + (Math.min(0, x - v) / scale) * 50}%`, width: `${(Math.abs(x - v) / scale) * 50}%` }}
                    />
                  ) : null,
                )}
              </span>
              <span className={s.torNum}>{bar.highDisplay}</span>
            </div>
          ))}
          <div className={s.torLegend}>
            <span>
              <span className={`${s.torSwatch} ${s.torLow}`} />
              {`Driver's target −${step}%`}
            </span>
            <span>
              <span className={`${s.torSwatch} ${s.torHigh}`} />
              {`Driver's target +${step}%`}
            </span>
          </div>
        </>
      )}
    </section>
  );
}

export function ScenarioResults({ res, busy, onFocus }: { res: ScenarioResult; busy: boolean; onFocus: (id: string) => void }) {
  const focus = res.tornado ? res.tornado.metricId : '';
  return (
    <div className={busy ? `${s.results} ${s.isLoading}` : s.results}>
      <div className={s.kpis} role="group" aria-label="Scenario results">
        {res.metrics.length === 0 && (
          <div className={s.kpisEmpty}>
            <Icon name="gauge" size={20} />
            <p className={s.kpisEmptyH}>No metrics in this scenario yet</p>
            <p>Add the metrics you want to see move — revenue, margin, units — and every driver is applied to all of them at once.</p>
          </div>
        )}
        {res.metrics.map((m) => (
          <Kpi key={m.metricId} m={m} focused={m.metricId === focus} onFocus={() => onFocus(m.metricId)} />
        ))}
      </div>
      <Tornado res={res} onFocus={onFocus} />
      {res.notes.length > 0 && (
        <ul className={s.notes}>
          {res.notes.map((n) => (
            <li key={n}>
              <Icon name="info" size={12} />
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
