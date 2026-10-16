// Admin → Embedding (docs/embed/00-design.md): published dashboards inside
// another site's iframe, by a link the host's BACKEND signs. Off until an
// admin turns it on; the sites allowed to frame it are exact origins; the
// signing secret is made by the server, shown here ONCE, and only ever
// replaced (Rotate), never shown again. Below: the signing code to paste into
// the host's backend, and a live preview.

import { useState, type FormEvent } from 'react';
import { Badge } from '../../ui/Badge';
import { Button, IconButton } from '../../ui/Button';
import { Switch } from '../../ui/Choice';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonBlock } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { normalizeOrigin, reason, useEmbedRotate, useEmbedSave, useEmbedSettings, type EmbedSettings } from '../embed/api';
import { copy, EmbedSnippets } from '../embed/EmbedSnippets';
import { EmbedPreviewCard } from './EmbedPreviewCard';
import a from './Admin.module.css';
import s from '../embed/Embed.module.css';

function Hero({ st }: { st: EmbedSettings }) {
  const steps = [
    { done: st.secretSet, label: 'Signing secret' },
    { done: st.origins.length > 0, label: st.origins.length === 1 ? '1 site allowed' : `${st.origins.length} sites allowed` },
    { done: st.enabled, label: st.enabled ? 'Embedding on' : 'Embedding off' },
  ];
  return (
    <div className={s.hero}>
      <span className={s.heroIcon} aria-hidden="true">
        <Icon name="layout-dashboard" size={20} />
      </span>
      <div className={s.heroText}>
        <h3 className={s.heroTitle}>Show published dashboards inside your portal or app</h3>
        <p className={s.lead}>
          Your backend signs a short-lived link for each page view — with locked filters, so a customer sees only their own rows. The browser never holds the secret,
          and only the sites below may frame a dashboard.
        </p>
      </div>
      <ul className={s.steps} aria-label="Set-up">
        {steps.map((x) => (
          <li key={x.label} className={x.done ? `${s.step} ${s.stepDone}` : s.step}>
            <Icon name={x.done ? 'circle-check' : 'circle'} size={12} />
            {x.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The switch and the sites; every change is saved at once. */
function Access({ st }: { st: EmbedSettings }) {
  const save = useEmbedSave();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const commit = (next: { enabled: boolean; origins: string[] }, done: string) =>
    save.mutate(next, {
      onSuccess: (r) => {
        if (!r.ok) return setError(r.error);
        setError('');
        toast(done, { kind: 'success' });
      },
      onError: (e) => setError(reason(e, 'The change did not go through.')),
    });
  const typed = draft.trim() ? normalizeOrigin(draft) : null;
  const typedError = draft.trim() && !typed ? 'https://host (or http://localhost:port) — no path, no wildcard.' : st.origins.includes(typed ?? '') ? 'Already allowed.' : undefined;
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!typed || typedError) return;
    commit({ enabled: st.enabled, origins: [...st.origins, typed] }, `${typed} can frame dashboards.`);
    setDraft('');
  };
  const why = !st.canStore ? 'Needs a database and ORDINATE_MASTER_KEY on the server.' : !st.secretSet ? 'Generate a signing secret first.' : !st.origins.length ? 'Allow at least one site first.' : undefined;
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>
          <Icon name="globe" size={16} /> Who may frame a dashboard
        </h3>
        <Badge tone={st.enabled ? 'ok' : 'neutral'}>{st.enabled ? 'On' : 'Off'}</Badge>
      </div>
      <Switch
        label="Allow embedding"
        hint={why ?? (st.enabled ? 'Signed links work on the sites below. Off: every embed stops at once.' : 'Signed links are refused until this is on.')}
        checked={st.enabled}
        disabled={(!!why && !st.enabled) || save.isPending}
        onCheckedChange={(on) => commit({ enabled: on, origins: st.origins }, on ? 'Embedding is on.' : 'Embedding is off. Every embed stopped.')}
      />
      {st.origins.length ? (
        <ul className={s.origins} aria-label="Allowed sites">
          {st.origins.map((o) => (
            <li key={o} className={s.origin}>
              <Icon name="link" size={12} />
              <code>{o}</code>
              <IconButton
                icon="x"
                size="sm"
                label={`Remove ${o}`}
                disabled={save.isPending || (st.enabled && st.origins.length === 1)}
                onClick={() => commit({ enabled: st.enabled, origins: st.origins.filter((x) => x !== o) }, `${o} can no longer frame dashboards.`)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className={s.originsEmpty}>No site yet. Add the exact origin of each page that will show a dashboard — your portal, your app, its staging copy.</p>
      )}
      <form className={s.addRow} onSubmit={add} aria-label="Add an allowed site">
        <Input label="Allow a site" placeholder="https://portal.example.com" value={draft} onChange={(e) => setDraft(e.target.value)} error={typedError} disabled={!st.canStore}
          hint="The browser checks it: a page on any other site gets a blank, blocked frame." spellCheck={false} autoComplete="off" />
        <Button type="submit" icon="plus" disabled={!typed || !!typedError || save.isPending || st.origins.length >= st.maxOrigins}>
          Allow
        </Button>
      </form>
      {error && (
        <p className={s.warn} role="alert">
          <Icon name="alert" size={12} /> {error}
        </p>
      )}
    </div>
  );
}

function Secret({ st }: { st: EmbedSettings }) {
  const rotate = useEmbedRotate();
  const [fresh, setFresh] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const make = () =>
    rotate.mutate(undefined, {
      onSuccess: (r) => {
        setConfirm(false);
        if (r.ok) setFresh(r.secret);
        else toast(r.error, { kind: 'error' });
      },
      onError: (e) => toast(reason(e, 'No secret was made.'), { kind: 'error' }),
    });
  return (
    <div className={s.card}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>
          <Icon name="lock" size={16} /> Signing secret
        </h3>
        {st.secretSet ? <Badge tone="ok" icon="lock">Stored</Badge> : <Badge tone="warn">Not set</Badge>}
      </div>
      <dl className={s.kv}>
        <dt>Key id (kid)</dt>
        <dd className={s.mono}>{st.org}</dd>
        <dt>Algorithm</dt>
        <dd className={s.mono}>HS256</dd>
        <dt>Longest link life</dt>
        <dd>{st.maxTtlHours} hours — sign a fresh link per page view</dd>
      </dl>
      {fresh && (
        <div className={s.fresh} role="status">
          <p className={s.freshHead}>Your new signing secret</p>
          <div className={s.secret}>
            <code data-testid="embed-secret">{fresh}</code>
            <Button size="sm" icon="copy" onClick={() => copy(fresh, 'The secret')}>
              Copy
            </Button>
          </div>
          <p className={s.warn}>
            <Icon name="alert" size={12} />
            <span>This is the only time it is shown. Put it in your backend’s secret store as ORDINATE_EMBED_SECRET — never in a browser.</span>
          </p>
          <div>
            <Button size="sm" onClick={() => setFresh(null)}>
              I have stored it
            </Button>
          </div>
        </div>
      )}
      <div className={s.secretRow}>
        {st.secretSet ? (
          <Dialog
            open={confirm}
            onOpenChange={setConfirm}
            size="sm"
            trigger={
              <Button icon="rotate-ccw" disabled={!st.canStore}>
                Rotate…
              </Button>
            }
            title="Rotate the signing secret?"
            description="Every embed signed with the current secret stops working at once, until your backend signs with the new one."
            footer={
              <>
                <DialogClose asChild>
                  <Button>Keep it</Button>
                </DialogClose>
                <Button variant="danger" loading={rotate.isPending} onClick={make}>
                  Rotate secret
                </Button>
              </>
            }
          />
        ) : (
          <Button variant="primary" icon="lock" loading={rotate.isPending} disabled={!st.canStore} onClick={make}>
            Generate secret
          </Button>
        )}
        <span className={s.formNote}>Kept encrypted on the server. Ordinate can replace it, never show it again.</span>
      </div>
    </div>
  );
}

export function EmbeddingTab() {
  const q = useEmbedSettings();
  if (q.isPending) return <SkeletonBlock label="Loading embedding settings" />;
  if (q.isError) return <ErrorState heading={3} title="Embedding settings could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  const st = q.data;
  return (
    <section className={a.section} aria-label="Embedding">
      <Hero st={st} />
      {!st.canStore && (
        <div className={a.notice} role="note">
          <Icon name="lock" />
          <div>
            <h3 className={a.noticeTitle}>This server cannot keep a signing secret yet</h3>
            <p className={a.lead}>
              The secret is a credential, so it is only ever stored encrypted — and that needs a database and a master key. Set DATABASE_URL and ORDINATE_MASTER_KEY on the
              server, restart it, and embedding can be set up here.
            </p>
          </div>
        </div>
      )}
      <div className={s.grid}>
        <div className={s.stack}>
          <Access st={st} />
          <Secret st={st} />
        </div>
        <div className={s.stack}>
          <div className={s.card}>
            <h3 className={s.cardTitle}>
              <Icon name="code" size={16} /> Sign a link on your server
            </h3>
            <p className={s.lead}>
              Paste this into the backend that renders the page. Each dashboard’s <strong>Embed…</strong> (Dashboards → ⋯ on a published link) fills in its ids and locks.
            </p>
            <EmbedSnippets input={{ server: window.location.origin, org: st.org }} />
          </div>
        </div>
      </div>
      <EmbedPreviewCard canPreview={st.canStore && st.secretSet} />
    </section>
  );
}
