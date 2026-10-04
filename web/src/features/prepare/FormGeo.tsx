// The SPATIAL JOIN step's editor — "Assign regions" (legacy prepareGeo.ts). The
// boundaries are the three bundled sets or one of the project's imported ones;
// the preview — "4,812 of 5,000 points matched · 7 regions", its meter, the
// busiest regions — is counted by the server over the step's real input, and
// Save runs as a job there (point in polygon over every row).

import { formatNumber } from '../../../../src/app/format.ts';
import { previewSpatial, useBoundarySources } from './api';
import { buildStep } from './drafts';
import { fmtN } from './steps';
import { NameSelect, PreviewBox, str, TextField, usePreview, type FormProps } from './FormParts';
import s from './Prepare.module.css';

const BUNDLED: readonly { id: string; name: string; hint: string }[] = [
  { id: 'us_state', name: 'US states', hint: '50 states, DC and Puerto Rico' },
  { id: 'country', name: 'Countries', hint: 'Every country, by name' },
  { id: 'us_county', name: 'US counties', hint: '3,221 counties, named with their state' },
];

export function SpatialJoinForm({ draft, set, ctx }: FormProps) {
  const nums = ctx.columns.filter((c) => c.type === 'number').map((c) => c.name);
  const sources = useBoundarySources(ctx.projectId, true);
  const custom = sources.data?.custom ?? [];
  const boundary = str(draft.boundary) || 'us_state';
  const boundaryId = str(draft.boundaryId);
  const chosen = custom.find((b) => b.id === boundaryId);

  const built = buildStep('spatial_join', draft, ctx.columns);
  const step = 'steps' in built ? built.steps[0] : null;
  const p = usePreview(step ? JSON.stringify(step) : null, () => previewSpatial(ctx.projectId, ctx.datasetId, ctx.index, step!));
  const st = p.data?.ok ? p.data.stats : null;

  const tiles = [
    ...BUNDLED.map((b) => ({ key: b.id, name: b.name, hint: b.hint, on: boundary === b.id, pick: () => set({ boundary: b.id, boundaryId: '', property: '' }) })),
    ...custom.map((b) => ({
      key: `custom:${b.id}`,
      name: b.name,
      hint: `${formatNumber(b.featureCount)} regions · your boundaries`,
      on: boundary === 'custom' && boundaryId === b.id,
      pick: () => set({ boundary: 'custom', boundaryId: b.id, property: (b.properties.find((x) => x.unique) ?? b.properties[0])?.key ?? '' }),
    })),
  ];
  return (
    <>
      <div className={s.field}>
        <span className={s.legend} id="sj-boundaries">
          Boundaries
        </span>
        <div className={s.tiles} role="radiogroup" aria-labelledby="sj-boundaries">
          {tiles.map((t) => (
            <button key={t.key} type="button" role="radio" aria-checked={t.on} className={t.on ? `${s.tile} ${s.tileOn}` : s.tile} onClick={t.pick}>
              <span className={s.tileName}>{t.name}</span>
              <span className={s.tileHint}>{t.hint}</span>
            </button>
          ))}
        </div>
      </div>
      {boundary === 'custom' && chosen && (
        <NameSelect label="Region name property" value={str(draft.property)} names={chosen.properties.map((x) => x.key)} onChange={(property) => set({ property })} />
      )}
      <div className={s.grid2}>
        <NameSelect label="Latitude" value={str(draft.lat)} names={nums} onChange={(lat) => set({ lat })} />
        <NameSelect label="Longitude" value={str(draft.lng)} names={nums} onChange={(lng) => set({ lng })} />
        <TextField label="New column" value={draft.as} onChange={(as) => set({ as })} />
        <TextField label="Points in no region get" value={draft.unmatched} placeholder="(empty)" onChange={(unmatched) => set({ unmatched })} />
      </div>
      {nums.length < 2 && <p className={s.hint}>This step needs two number columns — a latitude and a longitude.</p>}
      {step && (
        <PreviewBox busy={p.busy} warn={!!st && st.matched < st.total}>
          {st ? (
            <>
              <div>
                {fmtN(st.matched)} of {fmtN(st.total)} points matched · {fmtN(st.regions)} {st.regions === 1 ? 'region' : 'regions'}
              </div>
              <div className={s.meter} role="img" aria-label={`${st.pct}% of points matched`}>
                <div className={s.meterFill} style={{ width: `${st.pct}%` }} />
              </div>
              {st.top.length > 0 && (
                <div className={s.chips}>
                  {st.top.map((t) => (
                    <span key={t.name} className={s.chip}>
                      {t.name} · {fmtN(t.count)}
                    </span>
                  ))}
                </div>
              )}
              {(st.noCoords > 0 || st.outside > 0) && (
                <div>
                  {[
                    st.noCoords > 0 ? `${fmtN(st.noCoords)} ${st.noCoords === 1 ? 'row' : 'rows'} with no usable coordinates` : '',
                    st.outside > 0 ? `${fmtN(st.outside)} outside every region` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </>
          ) : (
            <div>{p.error ?? (p.data && !p.data.ok ? p.data.error : 'Counting…')}</div>
          )}
        </PreviewBox>
      )}
    </>
  );
}
