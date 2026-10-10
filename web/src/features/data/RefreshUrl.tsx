// "Refresh URL" (live data L0.5): a URL a dbt run or an Airflow DAG calls when
// new data has landed. It does exactly one thing — refresh this dataset (on a
// Live one, reset its cache) — at most once per the server's interval. Opened
// from the dataset page's menu and from a connection's details rail, where a
// URL can also be made for the CONNECTION: one call for every dataset that
// came from it.
//
// The URL is shown ONCE, right after it is made: the server keeps only its
// hash and a short prefix, so the list can name a URL but never show it
// again, and closing the panel forgets it here too. A project editor can
// revoke any of them; anything calling a revoked URL gets a 404.

import { useState } from 'react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { toast } from '../../ui/Toast';
import { ago } from './format';
import { hookUrl, intervalText, lastCall, snippets, useCreateHook, useRefreshHooks, useRevokeHook, type HookTarget, type RefreshHook } from './refreshUrls';
import s from './RefreshUrl.module.css';

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(
    () => toast(`${what} copied.`, { kind: 'success' }),
    () => toast('Copy failed — select the text and copy it instead.', { kind: 'error' }),
  );
}

function RevokeButton({ hook, projectId, target }: { hook: RefreshHook; projectId: string; target: HookTarget }) {
  const [open, setOpen] = useState(false);
  const revoke = useRevokeHook(projectId, target);
  const go = () =>
    revoke.mutate(hook.id, {
      onSuccess: (r) => {
        toast(r.ok ? `Revoked ${hook.prefix}….` : 'It was already revoked.', { kind: r.ok ? 'success' : 'info' });
        setOpen(false);
      },
      onError: (err) => toast(`Could not revoke it: ${err.message}`, { kind: 'error' }),
    });
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      size="sm"
      trigger={
        <Button size="sm" variant="ghost" icon="trash" aria-label={`Revoke ${hook.prefix}`}>
          Revoke
        </Button>
      }
      title="Revoke this refresh URL?"
      description="Anything still calling it gets a 404 from its next call. This cannot be undone."
      footer={
        <>
          <DialogClose asChild>
            <Button>Keep it</Button>
          </DialogClose>
          <Button variant="danger" loading={revoke.isPending} onClick={go}>
            Revoke URL
          </Button>
        </>
      }
    />
  );
}

function HookRow({ hook, projectId, target }: { hook: RefreshHook; projectId: string; target: HookTarget }) {
  const revoked = hook.revokedAt !== null;
  const last = revoked ? null : lastCall(hook);
  return (
    <li className={revoked ? `${s.row} ${s.revoked}` : s.row}>
      <div className={s.rowMain}>
        <code className={s.prefix}>{hook.prefix}…</code>
        <Badge tone={revoked ? 'neutral' : 'ok'}>{revoked ? 'Revoked' : 'Active'}</Badge>
        {/* How its last call ended — what a GET of the URL tells the pipeline. */}
        {last && <Badge tone={last.tone}>{last.word}</Badge>}
      </div>
      <p className={s.rowMeta}>
        Made by {hook.createdBy} · {ago(hook.createdAt)}
        {' · '}
        {revoked ? `revoked ${ago(hook.revokedAt ?? undefined)}` : hook.lastUsedAt ? `last called ${ago(hook.lastUsedAt)}` : 'never called'}
      </p>
      <div className={s.rowAction}>{!revoked && <RevokeButton hook={hook} projectId={projectId} target={target} />}</div>
    </li>
  );
}

/** The one-time view of a new URL. */
function NewUrl({ token }: { token: string }) {
  const url = hookUrl(token);
  return (
    <div className={s.fresh} role="status">
      <p className={s.freshHead}>Your new refresh URL</p>
      <div className={s.secret}>
        <code data-testid="new-refresh-url">{url}</code>
        <Button size="sm" icon="copy" onClick={() => copy(url, 'The URL')}>
          Copy
        </Button>
      </div>
      <p className={s.warn}>
        <Icon name="alert" size={16} />
        <span>This is the only time it is shown. Store it as a secret in your scheduler; if it is lost, revoke it and make a new one.</span>
      </p>
    </div>
  );
}

function Usage({ name, interval }: { name: string; interval: number }) {
  const [tab, setTab] = useState('curl');
  const code = snippets(name);
  const text = code[tab as keyof typeof code];
  return (
    <section className={s.section} aria-label="Call it">
      <h3 className={s.h}>Call it</h3>
      <p className={s.lead}>
        A POST with no body or headers. It answers <code>202</code> at once, and <code>429</code> with <code>Retry-After</code> when it was
        called less than {interval === 60 ? 'a minute' : `${interval} seconds`} ago. A GET of the same URL says how that call ended:{' '}
        <code>running</code>, <code>ok</code> or <code>failed</code>.
      </p>
      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="Examples">
          <Tab value="curl" icon="terminal">
            curl
          </Tab>
          <Tab value="dbt" icon="layers">
            dbt
          </Tab>
          <Tab value="airflow" icon="activity">
            Airflow
          </Tab>
        </TabList>
        {(['curl', 'dbt', 'airflow'] as const).map((k) => (
          <TabPanel key={k} value={k}>
            <div className={s.snippetWrap}>
              <pre className={s.snippet}>{code[k]}</pre>
              <Button size="sm" variant="ghost" icon="copy" className={s.copySnippet} onClick={() => copy(text, 'The example')} aria-label={`Copy the ${k} example`}>
                Copy
              </Button>
            </div>
          </TabPanel>
        ))}
      </Tabs>
    </section>
  );
}

/** What a call does, in the panel's lead sentence. */
function Does({ target, name, live }: { target: HookTarget; name: string; live: boolean }) {
  if ('connId' in target) return <>refreshes every dataset that came from “{name}” from its source, and resets the cache of the Live ones</>;
  return live ? <>resets the cache of “{name}”, so the next question goes to the warehouse</> : <>refreshes “{name}” from its source</>;
}

function Body({ projectId, target, name, live }: { projectId: string; target: HookTarget; name: string; live: boolean }) {
  const list = useRefreshHooks(projectId, target, true);
  const create = useCreateHook(projectId, target);
  const [token, setToken] = useState<string | null>(null);
  const make = () =>
    create.mutate(undefined, {
      onSuccess: (r) => (r.ok ? setToken(r.token) : toast(r.error, { kind: 'error' })),
      onError: (err) => toast(`Could not make one: ${err.message}`, { kind: 'error' }),
    });

  if (list.isPending) return <SkeletonRows rows={4} label="Loading the refresh URLs" />;
  if (list.isError) {
    if ((list.error as { status?: number }).status === 403) {
      return (
        <EmptyState heading={3} icon="lock" title="Editors only">
          Only editors of this project can see and make its refresh URLs.
        </EmptyState>
      );
    }
    return <ErrorState heading={3} title="The refresh URLs could not be loaded" message={list.error.message} onRetry={() => void list.refetch()} />;
  }
  if (!list.data.available) {
    return (
      <EmptyState heading={3} icon="database" title="Refresh URLs need the server’s database">
        A refresh URL is kept in Postgres, and this server runs without one. Ask an administrator to set DATABASE_URL.
      </EmptyState>
    );
  }
  const hooks = list.data.hooks;
  const active = hooks.filter((h) => h.revokedAt === null).length;
  return (
    <>
      <p className={s.lead}>
        Call it from dbt, Airflow or any scheduler when new data has landed, and Ordinate <Does target={target} name={name} live={live} />. It can
        do nothing else, and it works at most {intervalText(list.data.minIntervalSec)}.
      </p>
      {token && <NewUrl token={token} />}
      <section className={s.section} aria-label="Refresh URLs">
        <div className={s.bar}>
          <h3 className={s.h}>URLs{active > 0 ? ` · ${active} active` : ''}</h3>
          <Button size="sm" variant={hooks.length ? 'secondary' : 'primary'} icon="plus" loading={create.isPending} onClick={make}>
            New refresh URL
          </Button>
        </div>
        {hooks.length === 0 ? (
          <EmptyState compact heading={3} icon="link" title="No refresh URLs yet">
            Make one, then paste it into your pipeline’s secrets.
          </EmptyState>
        ) : (
          <ul className={s.list}>
            {hooks.map((h) => (
              <HookRow key={h.id} hook={h} projectId={projectId} target={target} />
            ))}
          </ul>
        )}
      </section>
      <Usage name={name} interval={list.data.minIntervalSec} />
    </>
  );
}

/** The panel. Its owner unmounts it on close, so a new URL never outlives it. */
export function RefreshUrlDialog({ projectId, target, name, live = false, onClose }: {
  projectId: string;
  /** A dataset, or a connection: one URL for every dataset that came from it. */
  target: HookTarget;
  /** The dataset's name, or the connection's. */
  name: string;
  live?: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Refresh URL · ${name}`}
      footer={
        <DialogClose asChild>
          <Button>Done</Button>
        </DialogClose>
      }
    >
      <Body projectId={projectId} target={target} name={name} live={live} />
    </Dialog>
  );
}
