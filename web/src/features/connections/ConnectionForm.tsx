// Step 2 — the chosen source's form, rendered from its declared fields (legacy
// connNew.ts connRenderFields / connCollectValues / handleConnTestAndSave).
//
// A SECRET field is write-only: a password input — or, for a multi-line one (a
// PEM private key), the masked SecretTextarea — never prefilled, its value kept
// apart from the rest and sent once, inside testAndSave. "Change source" keeps
// the non-secret answers (the parent holds them per connector id); the secrets
// are simply dropped. A test that passes with a warning (an administrator role)
// hands the warning on with the saved connection.

import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Choice';
import { Input, Textarea } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { testAndSave, type CatalogField, type Connection, type Connector, type Logo } from './api';
import { ConnLogo } from './ConnLogo';
import { SecretTextarea } from './SecretText';
import s from './Connections.module.css';

export type Draft = Record<string, string | boolean>;

/** The form's starting answers: a kept draft, else each field's default. Never a secret. */
export function initialDraft(def: Connector, kept?: Draft): Draft {
  const out: Draft = {};
  for (const f of def.fields) {
    if (f.secret) continue;
    const v = kept?.[f.key] ?? f.default;
    out[f.key] = f.type === 'checkbox' ? v === true : v === undefined ? '' : String(v);
  }
  return out;
}

/** Form strings → the typed values the server coerces again. Blank answers are left out. */
export function collect(def: Connector, draft: Draft): { values: Record<string, string | number | boolean>; missing: CatalogField[] } {
  const values: Record<string, string | number | boolean> = {};
  const missing: CatalogField[] = [];
  for (const f of def.fields) {
    if (f.secret) continue;
    const raw = draft[f.key];
    if (f.type === 'checkbox') {
      values[f.key] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) {
      if (f.required) missing.push(f);
      continue;
    }
    const n = Number(text);
    values[f.key] = f.type === 'number' && Number.isFinite(n) ? n : text;
  }
  return { values, missing };
}

const fieldId = (key: string) => `conn-f-${key}`;

export function ConnectionForm({
  def,
  logo,
  projectId,
  draft,
  onDraft,
  onBack,
  onSaved,
}: {
  def: Connector;
  logo?: Logo;
  projectId: string;
  draft: Draft;
  onDraft: (d: Draft) => void;
  onBack: () => void;
  onSaved: (c: Connection, warnings: string[]) => void;
}) {
  const [name, setName] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const { values, missing } = collect(def, draft);
    const missingSecrets = def.fields.filter((f) => f.secret && f.required && !secrets[f.key]);
    const all = [...missing, ...missingSecrets];
    setInvalid(new Set(all.map((f) => f.key)));
    if (all.length) {
      setError(all.length === 1 ? `${all[0].label} is required.` : `These fields are required: ${all.map((f) => f.label).join(', ')}.`);
      form.current?.querySelector<HTMLElement>(`#${fieldId(all[0].key)}`)?.focus();
      return;
    }
    setBusy(true);
    try {
      const saved = await testAndSave({ projectId, connectorId: def.id, name: name.trim() || undefined, values, secrets });
      setSecrets({});
      onSaved(saved.connection, saved.warnings);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect.');
    } finally {
      setBusy(false);
    }
  }

  function control(f: CatalogField) {
    const id = fieldId(f.key);
    const label = f.required ? `${f.label} *` : f.label;
    const err = invalid.has(f.key) ? `${f.label} is required.` : undefined;
    const set = (v: string | boolean) => {
      onDraft({ ...draft, [f.key]: v });
      if (invalid.has(f.key)) setInvalid(new Set([...invalid].filter((k) => k !== f.key)));
    };
    const writeOnly = f.help ? `${f.help} Write-only: it is stored encrypted and never shown again.` : 'Write-only: it is stored encrypted and never shown again.';
    if (f.secret && f.type === 'textarea') {
      return (
        <SecretTextarea
          id={id}
          label={label}
          placeholder={f.placeholder}
          value={secrets[f.key] ?? ''}
          onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })}
          error={err}
          hint={writeOnly}
        />
      );
    }
    if (f.secret) {
      return (
        <Input
          id={id}
          type="password"
          label={label}
          autoComplete="new-password"
          placeholder={f.placeholder}
          value={secrets[f.key] ?? ''}
          onChange={(e) => setSecrets({ ...secrets, [f.key]: e.target.value })}
          error={err}
          hint={writeOnly}
        />
      );
    }
    if (f.type === 'checkbox') return <Checkbox id={id} label={f.label} hint={f.help} checked={draft[f.key] === true} onCheckedChange={set} />;
    if (f.type === 'select') {
      return (
        <Select
          id={id}
          label={label}
          hint={f.help}
          error={err}
          value={typeof draft[f.key] === 'string' && draft[f.key] !== '' ? (draft[f.key] as string) : null}
          onValueChange={set}
          options={(f.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        />
      );
    }
    const common = { id, label, hint: f.help, error: err, placeholder: f.placeholder, value: String(draft[f.key] ?? ''), spellCheck: false };
    if (f.type === 'textarea') return <Textarea {...common} rows={4} className={s.mono} onChange={(e) => set(e.target.value)} />;
    return <Input {...common} type={f.type === 'number' ? 'number' : 'text'} autoComplete="off" onChange={(e) => set(e.target.value)} />;
  }

  const hosts = def.hosts?.length ? ` Connects only to ${def.hosts.join(', ')}.` : '';
  return (
    <section className={s.form} aria-labelledby="conn-form-h">
      <div className={s.chosenHead}>
        <div className={s.chosenIdent}>
          <ConnLogo logo={logo} label={def.label} />
          <div className={s.chosenText}>
            <h2 id="conn-form-h" className={s.chosenName}>
              {def.label}
            </h2>
            {(def.blurb || hosts) && <p className={s.muted}>{(def.blurb ?? '') + hosts}</p>}
          </div>
        </div>
        <Button size="sm" icon="arrow-left" onClick={onBack}>
          Change source
        </Button>
      </div>
      <form ref={form} className={s.fields} onSubmit={(e) => void submit(e)} noValidate>
        <Input label="Name" placeholder="Optional connection name" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        {def.fields.map((f) => (
          <div key={f.key}>{control(f)}</div>
        ))}
        {error && (
          <p className={s.error} role="alert">
            {error}
          </p>
        )}
        <div className={s.formActions}>
          <Button type="submit" variant="primary" icon="plug" loading={busy}>
            Test &amp; Save
          </Button>
          <span className={s.muted}>Read-only: nothing is ever written to the source.</span>
        </div>
      </form>
    </section>
  );
}
