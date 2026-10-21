// API tokens (T3.4): every member's own personal tokens for the CLI, MCP
// clients and scripts. A new token is shown ONCE, in the dialog that created
// it — the server keeps only its hash and a short prefix, so the list can
// name a token but never show it again. Revoking stops it at once. Every token
// has an end (docs/sso-lifecycle): 30, 90 or 365 days, up to the server's
// API_TOKEN_MAX_DAYS; one made before tokens had an end is marked.

import { useState, type FormEvent } from 'react';
import { Page } from '../../app/blocks';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { Icon } from '../../ui/icons/Icon';
import { PageSkeleton, SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useMe } from '../auth/api';
import { fmtDate, fmtDateTime, useTokens, useWrite, type ApiToken, type Created } from './api';
import { NoAccounts } from './NoAccounts';
import s from './Admin.module.css';

function copy(text: string) {
  navigator.clipboard.writeText(text).then(
    () => toast('Copied.', { kind: 'success' }),
    () => toast('Copy failed — select the text and copy it instead.', { kind: 'error' }),
  );
}

/** The lifetimes offered: 30, 90 and 365 days up to the server's maximum, and the maximum itself when it is shorter. */
function expiryOptions(maxDays: number): number[] {
  const out = [30, 90, 365].filter((d) => d <= maxDays);
  if (maxDays < 365 && !out.includes(maxDays)) out.push(maxDays);
  return out.sort((a, b) => a - b);
}
const daysLabel = (d: number) => (d === 365 ? '1 year' : d === 1 ? '1 day' : `${d} days`);

function CreateDialog({ maxDays }: { maxDays: number }) {
  const options = expiryOptions(maxDays);
  const preferred = options.includes(90) ? 90 : options[options.length - 1];
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [days, setDays] = useState(preferred);
  const [made, setMade] = useState<{ token: string; expiresAt: string } | null>(null);
  const create = useWrite<'tokens:create', Created>('tokens:create', ['tokens:list'], (r) => {
    if (r.ok) setMade({ token: r.token, expiresAt: r.expiresAt });
  });
  const close = (o: boolean) => {
    setOpen(o);
    if (!o) {
      setMade(null); // gone from this page for good once the dialog closes
      setName('');
      setDays(preferred);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ name: name.trim(), expiresInDays: days });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      trigger={
        <Button variant="primary" icon="plus">
          New token
        </Button>
      }
      title={made ? 'Copy your new token' : 'New API token'}
      description={made ? undefined : 'Name it after where it will be used, so you know what to revoke later.'}
      footer={
        made ? (
          <DialogClose asChild>
            <Button variant="primary">I have copied it</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button variant="primary" type="submit" form="token-form" loading={create.isPending} disabled={!name.trim()}>
              Create token
            </Button>
          </>
        )
      }
    >
      {made ? (
        <div className={s.dialogBody}>
          <div className={s.secret}>
            <code data-testid="new-token">{made.token}</code>
            <Button size="sm" icon="copy" onClick={() => copy(made.token)}>
              Copy
            </Button>
          </div>
          <p className={s.lead}>It stops working on {fmtDate(made.expiresAt)}.</p>
          <p className={s.warn}>
            <Icon name="alert" size={16} />
            This is the only time the token is shown. Store it somewhere safe; if it is lost, revoke it and make a new one.
          </p>
        </div>
      ) : (
        <form id="token-form" className={s.dialogBody} onSubmit={submit}>
          <Input label="Name" placeholder="e.g. Laptop CLI" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Select
            label="Expires after"
            value={String(days)}
            onValueChange={(v) => setDays(Number(v))}
            options={options.map((d) => ({ value: String(d), label: daysLabel(d) }))}
          />
        </form>
      )}
    </Dialog>
  );
}

function RevokeButton({ t }: { t: ApiToken }) {
  const [open, setOpen] = useState(false);
  const revoke = useWrite('tokens:revoke', ['tokens:list'], (r) => {
    if (r.ok) toast(`Revoked ${t.name}.`, { kind: 'success' });
    setOpen(false);
  });
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="sm"
      trigger={
        <Button size="sm" variant="ghost" icon="trash" aria-label={`Revoke ${t.name}`}>
          Revoke
        </Button>
      }
      title={`Revoke ${t.name}?`}
      description="Anything using it stops working at its next request. This cannot be undone."
      footer={
        <>
          <DialogClose asChild>
            <Button>Keep it</Button>
          </DialogClose>
          <Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate({ id: t.id })}>
            Revoke token
          </Button>
        </>
      }
    />
  );
}

export default function TokensPage() {
  const me = useMe();
  if (me.isPending) return <PageSkeleton />;
  if (me.data?.accounts === false) return <NoAccounts title="API tokens" />;
  return <Tokens />;
}

/** When a token ends: the date, Expired, and a mark on one made before tokens had an end. */
function Expiry({ t }: { t: ApiToken }) {
  return (
    <span className={s.cellRow}>
      {t.expired ? <Badge tone="error">Expired</Badge> : <span className={s.meta}>{fmtDate(t.expiresAt)}</span>}
      {t.legacy && <span className={s.meta}>Made before tokens expired</span>}
    </span>
  );
}

function Tokens() {
  const tokens = useTokens();
  const endpoint = `${window.location.origin}/api/mcp`;
  let body;
  if (tokens.isPending) body = <SkeletonTable cols={5} rows={3} label="Loading your tokens" />;
  else if (tokens.isError) {
    body = <ErrorState heading={3} title="Your tokens could not be loaded" message={tokens.error.message} onRetry={() => void tokens.refetch()} />;
  } else if (tokens.data.tokens.length === 0) {
    body = (
      <EmptyState heading={3} icon="terminal" title="No API tokens">
        Make one to use Ordinate from the command line, an MCP client or a script. It acts as you, with your role.
      </EmptyState>
    );
  } else {
    body = (
      <div className={s.card}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Token</th>
              <th scope="col">Created</th>
              <th scope="col">Last used</th>
              <th scope="col">Expires</th>
              <th scope="col" className={s.actions}>
                <span className={s.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tokens.data.tokens.map((t) => (
              <tr key={t.id}>
                <td className={s.strong}>{t.name}</td>
                <td className={s.mono}>{t.prefix}…</td>
                <td className={s.meta}>{fmtDate(t.createdAt)}</td>
                <td className={s.meta}>{t.lastUsedAt ? fmtDateTime(t.lastUsedAt) : 'Never'}</td>
                <td>
                  <Expiry t={t} />
                </td>
                <td className={s.actions}>
                  <RevokeButton t={t} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <Page title="API tokens" sub="Personal tokens act as you, with your current role, until they expire or you revoke them. Each is shown once.">
      <section className={s.section} aria-label="Your tokens">
        <div className={s.bar}>
          <h2 className={s.groupTitle}>Your tokens</h2>
          <div className={s.barEnd}>
            {tokens.data && <CreateDialog maxDays={tokens.data.maxDays} />}
          </div>
        </div>
        {body}
      </section>
      <section className={s.section} aria-label="Connect an MCP client">
        <h2 className={s.groupTitle}>Connect an MCP client</h2>
        <p className={s.lead}>Send the token as a bearer header to this server's MCP endpoint. For Claude Code:</p>
        <pre className={s.snippet}>{`claude mcp add --transport http ordinate ${endpoint} --header "Authorization: Bearer <token>"`}</pre>
      </section>
    </Page>
  );
}
