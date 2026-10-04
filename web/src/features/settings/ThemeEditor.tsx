// One theme's editor — themeEditor.ts, ported: fonts, the base palette, the
// accent and the eight-colour chart ramp, card style, KPI style and density,
// with the sample sheet redrawn as you go and a contrast warning beside every
// colour under its floor. It works on a DRAFT: nothing reaches the server
// until Save, which re-validates every token (src/app/themeStore.ts). A theme
// with warnings saves like any other — they are advice.

import { useState, type ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Choice';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Icon } from '../../ui/icons/Icon';
import { useWrite, type ThemeRecord } from './api';
import { Segmented } from './Rows';
import { ThemePreview } from './ThemePreview';
import { deriveAccent, deriveBase, deriveRamp, FONTS, hexOr, themeWarnings, type Tokens, type Warning } from './themeModel';
import t from './Themes.module.css';

const DENSITY: Record<string, [number, number]> = { comfortable: [12, 48], compact: [8, 36] };
const FONT_OPTIONS = Object.entries(FONTS).map(([value, f]) => ({ value, label: f.label }));

export interface Draft {
  id?: string;
  name: string;
  tokens: Tokens;
}

function ColorField({ token, label, tokens, warn, onSet }: { token: string; label: string; tokens: Tokens; warn?: Warning; onSet: (hex: string) => void }) {
  const v = hexOr(tokens[token], '#000000');
  const [text, setText] = useState<string | null>(null);
  const bad = text !== null && !/^#?[0-9a-f]{6}$/i.test(text.trim());
  const commit = () => {
    if (text === null || bad) return;
    const t2 = text.trim();
    onSet((t2.startsWith('#') ? t2 : '#' + t2).toLowerCase());
    setText(null);
  };
  return (
    <div className={t.color} data-token={token}>
      <div className={t.colorTop}>
        <input type="color" className={t.picker} value={v} aria-label={label} onChange={(e) => onSet(e.target.value.toLowerCase())} />
        <span className={t.colorText}>
          <span className={t.colorName}>{label}</span>
          <input
            className={t.hexIn}
            aria-label={`${label} as hex`}
            aria-invalid={bad || undefined}
            spellCheck={false}
            value={text ?? v}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
          />
        </span>
      </div>
      {warn && (
        <span className={t.warn} role="note">
          <Icon name="alert" size={12} />
          {warn.message}
        </span>
      )}
    </div>
  );
}

function Range({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <span className={t.range}>
      <input type="range" min={min} max={max} step={1} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} />
      <span className={t.rangeVal}>{value}px</span>
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={t.field}>
      <span className={t.fieldLabel}>{label}</span>
      <span className={t.fieldControl}>{children}</span>
    </div>
  );
}

function Sec({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className={t.sec} aria-label={title}>
      <h4 className={t.secHead}>{title}</h4>
      {desc && <p className={t.secDesc}>{desc}</p>}
      {children}
    </section>
  );
}

export function ThemeEditor({ start, onClose }: { start: Draft; onClose: () => void }) {
  const [name, setName] = useState(start.name);
  const [tokens, setTokens] = useState<Tokens>(start.tokens);
  const save = useWrite<'themes:save', { ok: boolean; error?: string; theme?: ThemeRecord }>('themes:save', [['themes:list']], (r) => r.ok && onClose());
  const warns = themeWarnings(tokens);
  const byToken = new Map(warns.map((w) => [w.token, w]));
  const set = (token: string, value: string | number, derive?: (x: Tokens) => Tokens) =>
    setTokens((cur) => (derive ? derive({ ...cur, [token]: value }) : { ...cur, [token]: value }));
  const font = (k: string) => (FONTS[tokens[k] as string] ? (tokens[k] as string) : 'hanken');
  const num = (k: string, d: number) => (typeof tokens[k] === 'number' ? (tokens[k] as number) : d);
  const density = Object.keys(DENSITY).find((k) => DENSITY[k][0] === tokens['--dash-gap'] && DENSITY[k][1] === tokens['--dash-row']) ?? '';
  const color = (token: string, label: string, derive?: (x: Tokens) => Tokens) => (
    <ColorField key={token} token={token} label={label} tokens={tokens} warn={byToken.get(token)} onSet={(h) => set(token, h, derive)} />
  );

  return (
    <div className={t.editor} aria-label={`Editing ${name || 'theme'}`} role="region">
      <div className={t.editorHead}>
        <Button variant="ghost" icon="arrow-left" onClick={onClose}>
          Themes
        </Button>
        <div className={t.nameField}>
          <Input label="Theme name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <span className={t.spacer} />
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon="check" loading={save.isPending} onClick={() => save.mutate({ ...(start.id ? { id: start.id } : {}), name, tokens })}>
          Save theme
        </Button>
      </div>
      {warns.length > 0 && (
        <div className={t.warnSummary} role="status">
          {warns.length === 1 ? 'One colour is under its contrast floor.' : `${warns.length} colours are under their contrast floor.`} It still saves — the warning is advice.
        </div>
      )}
      <div className={t.body}>
        <div className={t.controls}>
          <Sec title="Fonts" desc="From the four bundled families; they render when installed on the reader's machine, with system fallbacks otherwise.">
            {(
              [
                ['--font-ui', 'Text'],
                ['--font-numeric', 'Figures'],
              ] as const
            ).map(([k, label]) => (
              <Field key={k} label={label}>
                <span className={t.fontSelect}>
                  <Select aria-label={`${label} font`} value={font(k)} onValueChange={(v) => set(k, v)} options={FONT_OPTIONS} />
                </span>
                <span className={t.fontSample} style={{ fontFamily: FONTS[font(k)].stack }} aria-hidden="true">
                  Aa 123
                </span>
              </Field>
            ))}
          </Sec>
          <Sec title="Base palette" desc="Card heads, insets and the lighter text and border weights are derived from these four.">
            <div className={t.colorGrid}>
              {color('--bg', 'Background', deriveBase)}
              {color('--surface', 'Surface', deriveBase)}
              {color('--text', 'Text', deriveBase)}
              {color('--border', 'Border', deriveBase)}
            </div>
          </Sec>
          <Sec title="Accent and chart ramp" desc="Each colour is checked against the surface it is drawn on: 3:1 for graphics, 4.5:1 for text.">
            <div className={t.colorGrid}>{color('--accent', 'Accent', deriveAccent)}</div>
            <div className={t.colorGrid}>{Array.from({ length: 8 }, (_, i) => color(`--chart-${i + 1}`, `Series ${i + 1}`))}</div>
            <div>
              <Button size="sm" variant="ghost" icon="sparkles" onClick={() => setTokens((cur) => deriveRamp(cur))}>
                Derive ramp from accent
              </Button>
            </div>
          </Sec>
          <Sec title="Cards">
            <Field label="Border">
              <Segmented label="Card border" value={String(num('--dash-card-border-w', 1))} onChange={(v) => set('--dash-card-border-w', Number(v))} options={[{ value: '0', label: 'None' }, { value: '1', label: 'Hairline' }, { value: '2', label: 'Strong' }]} />
            </Field>
            <Field label="Shadow">
              <Segmented label="Card shadow" value={String(tokens['--dash-card-shadow'] ?? 'none')} onChange={(v) => set('--dash-card-shadow', v)} options={[{ value: 'none', label: 'None' }, { value: 'sm', label: 'Soft' }, { value: 'md', label: 'Raised' }, { value: 'lg', label: 'Lifted' }]} />
            </Field>
            <Field label="Corner radius">
              <Range label="Corner radius" value={num('--dash-card-radius', 12)} min={0} max={24} onChange={(v) => set('--dash-card-radius', v)} />
            </Field>
            <Switch label="Header rule" checked={tokens['--dash-card-rule'] !== 'off'} onCheckedChange={(on) => set('--dash-card-rule', on ? 'on' : 'off')} />
          </Sec>
          <Sec title="KPIs">
            <Field label="Value size">
              <Range label="KPI value size" value={num('--dash-kpi-size', 28)} min={18} max={48} onChange={(v) => set('--dash-kpi-size', v)} />
            </Field>
            <Field label="Label">
              <Segmented label="KPI label" value={String(tokens['--dash-kpi-label'] ?? 'below')} onChange={(v) => set('--dash-kpi-label', v)} options={[{ value: 'below', label: 'Below the figure' }, { value: 'above', label: 'Above' }]} />
            </Field>
          </Sec>
          <Sec title="Density" desc="The grid pitch a card keeps when the dashboard is laid out.">
            <Field label="Spacing">
              <Segmented
                label="Spacing"
                value={density}
                onChange={(v) => setTokens((cur) => ({ ...cur, '--dash-gap': DENSITY[v][0], '--dash-row': DENSITY[v][1] }))}
                options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]}
              />
            </Field>
          </Sec>
        </div>
        <aside className={t.previewPane} aria-label="Preview">
          <span className={t.previewLabel}>Preview</span>
          <ThemePreview tokens={tokens} />
          <p className={t.previewNote}>The sample dashboard, redrawn as you edit. Placeholder figures — a look, not data.</p>
        </aside>
      </div>
    </div>
  );
}
