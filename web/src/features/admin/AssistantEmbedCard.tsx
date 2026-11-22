// Admin → Embedding → Assistant (docs/embedded-assistant, phase 4): which agents may be embedded and on which datasets (each with the text
// column every signed link must lock), the daily and per-customer caps, and the signing code. The marking pins what writes the lock column,
// so a step added later turns it red here and the ask refuses until it is saved again.

import { useEffect, useState } from 'react';
import { useProjects } from '../../api/projects';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Checkbox, Switch } from '../../ui/Choice';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { Select } from '../../ui/Select';
import { SkeletonBlock } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { toast } from '../../ui/Toast';
import { copy } from '../embed/EmbedSnippets';
import { iframeSnippet, nodeAssistantSnippet, pythonAssistantSnippet } from '../embed/assistantSnippets';
import { reason } from '../embed/api';
import {
  useAssistantLimits, useAssistantOptions, useAssistantRemove, useAssistantSave, useAssistantSettings, type AssistantSettings, type MarkedAgent, type MarkState,
} from '../embed/assistantApi';
import s from '../embed/Embed.module.css';
import m from './AssistantEmbed.module.css';

const STATE: Record<MarkState, { tone: 'ok' | 'warn' | 'error'; text: string }> = {
  ok: { tone: 'ok', text: 'Locked' },
  changed: { tone: 'warn', text: 'Steps changed: save again' },
  column: { tone: 'error', text: 'Column gone or not text' },
  rules: { tone: 'error', text: 'Has row rules' },
  pipeline: { tone: 'error', text: 'Steps cross rows' },
  gone: { tone: 'error', text: 'Dataset gone' },
};

/** The editor for one agent: its project, the agent, and each embeddable dataset with its lock column. */
function MarkForm({ st, initial, onDone }: { st: AssistantSettings; initial?: MarkedAgent; onDone: () => void }) {
  const projects = useProjects();
  const [projectId, setProjectId] = useState<string | null>(initial?.projectId ?? null);
  const [agentId, setAgentId] = useState<string | null>(initial?.agentId ?? null);
  const [picked, setPicked] = useState<Record<string, string>>(Object.fromEntries((initial?.datasets ?? []).map((d) => [d.id, d.column])));
  const [error, setError] = useState('');
  const opts = useAssistantOptions(projectId);
  const save = useAssistantSave();
  const o = opts.data && opts.data.ok ? opts.data : null;
  useEffect(() => { if (o && agentId && !o.agents.some((a) => a.id === agentId)) setAgentId(null); }, [o, agentId]);
  const chosen = Object.entries(picked);
  const submit = () =>
    save.mutate({ projectId: projectId as string, agentId: agentId as string, enabled: initial?.enabled ?? true, datasets: chosen.map(([id, column]) => ({ id, column })) }, {
      onSuccess: (r) => {
        if (!r.ok) return setError(r.error);
        toast('The assistant can be embedded.', { kind: 'success' });
        onDone();
      },
      onError: (e) => setError(reason(e, 'The change did not go through.')),
    });
  return (
    <form className={m.form} onSubmit={(e) => { e.preventDefault(); submit(); }} aria-label="Mark an assistant embeddable">
      <Select label="Project" value={projectId} onValueChange={(v) => { setProjectId(v); setAgentId(null); setPicked({}); }} disabled={!!initial}
        options={(projects.data ?? []).filter((p) => !p.archivedAt).map((p) => ({ value: p.id, label: p.name }))} placeholder="Pick a project" />
      <Select label="Assistant agent" value={agentId} onValueChange={setAgentId} disabled={!!initial || !o} options={(o?.agents ?? []).map((a) => ({ value: a.id, label: a.name }))}
        placeholder={o && !o.agents.length ? 'This project has no agent yet' : 'Pick an agent'} />
      {o && (
        <fieldset className={m.datasets}>
          <legend>Datasets it may answer from (at most {st.limits.maxDatasets})</legend>
          {o.datasets.length === 0 && <p className={s.formNote}>This project has no dataset yet.</p>}
          {o.datasets.map((d) => (
            <div key={d.id} className={m.datasetRow}>
              <Checkbox label={d.name} checked={d.id in picked} disabled={!(d.id in picked) && chosen.length >= st.limits.maxDatasets}
                onCheckedChange={(on) => setPicked((p) => { const n = { ...p }; if (on) n[d.id] = d.textColumns[0] ?? ''; else delete n[d.id]; return n; })} />
              {d.id in picked && (
                <Select aria-label={`Lock column of ${d.name}`} size="sm" value={picked[d.id] || null} onValueChange={(c) => setPicked((p) => ({ ...p, [d.id]: c }))}
                  options={d.textColumns.map((c) => ({ value: c, label: c }))} placeholder={d.textColumns.length ? 'Pick the customer column' : 'No text column'} disabled={!d.textColumns.length} />
              )}
            </div>
          ))}
        </fieldset>
      )}
      {error && <p className={s.warn} role="alert"><Icon name="alert" size={12} /> {error}</p>}
      <div className={m.actions}>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!projectId || !agentId || !chosen.length || chosen.some(([, c]) => !c)}>Save</Button>
        <Button type="button" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function AgentRow({ a, onEdit }: { a: MarkedAgent; onEdit: () => void }) {
  const save = useAssistantSave();
  const remove = useAssistantRemove();
  const toggle = (enabled: boolean) =>
    save.mutate({ projectId: a.projectId, agentId: a.agentId, enabled, datasets: a.datasets.map((d) => ({ id: d.id, column: d.column })) }, { onSuccess: (r) => { if (!r.ok) toast(r.error, { kind: 'error' }); } });
  return (
    <li className={m.agent}>
      <div className={m.agentHead}>
        <strong>{a.agentName || 'An assistant that is gone'}</strong>
        <span className={m.where}>{a.projectName}</span>
        <Switch label="Embeddable" checked={a.enabled} disabled={a.gone || save.isPending} onCheckedChange={toggle} />
      </div>
      <ul className={m.marked} aria-label={`Datasets of ${a.agentName}`}>
        {a.datasets.map((d) => (
          <li key={d.id}>
            <span>{d.name || 'Gone'}</span> <code>{d.column}</code> <Badge tone={STATE[d.state].tone}>{STATE[d.state].text}</Badge>
          </li>
        ))}
      </ul>
      <div className={m.actions}>
        <Button size="sm" icon="pencil" onClick={onEdit}>Edit</Button>
        <Button size="sm" variant="danger" icon="trash" loading={remove.isPending} onClick={() => remove.mutate({ agentId: a.agentId }, { onSuccess: (r) => toast(r.ok ? 'Stopped embedding that assistant.' : r.error, { kind: r.ok ? 'success' : 'error' }) })}>Stop embedding</Button>
      </div>
      {a.datasets.some((d) => d.state === 'changed') && <p className={s.warn}><Icon name="alert" size={12} /> A step that writes a lock column changed. Questions are refused until you press Edit and Save.</p>}
    </li>
  );
}

function Caps({ st }: { st: AssistantSettings }) {
  const save = useAssistantLimits();
  const [daily, setDaily] = useState(String(st.caps.daily));
  const [perMinute, setPerMinute] = useState(String(st.caps.perMinute));
  const [error, setError] = useState('');
  const d = Number(daily);
  const p = Number(perMinute);
  const bad = !Number.isInteger(d) || d < 1 || d > st.limits.maxDaily || !Number.isInteger(p) || p < 1 || p > st.limits.maxPerMinute;
  return (
    <form className={m.caps} onSubmit={(e) => { e.preventDefault(); save.mutate({ daily: d, perMinute: p }, { onSuccess: (r) => { setError(r.ok ? '' : r.error); if (r.ok) toast('Caps saved.', { kind: 'success' }); } }); }} aria-label="Question caps">
      <Input label="Questions a day, whole org" type="number" min={1} max={st.limits.maxDaily} value={daily} onChange={(e) => setDaily(e.target.value)} hint={`Up to ${st.limits.maxDaily.toLocaleString()}. Past it, every customer is asked to try later.`} />
      <Input label="Questions a minute, per customer" type="number" min={1} max={st.limits.maxPerMinute} value={perMinute} onChange={(e) => setPerMinute(e.target.value)} hint="One customer cannot spend the day's budget." />
      <Button type="submit" loading={save.isPending} disabled={bad}>Save caps</Button>
      <p className={s.formNote}>{st.counts.today} answered and {st.counts.limited} held back in the last 24 hours. Every model call is paid by your organisation.</p>
      {error && <p className={s.warn} role="alert"><Icon name="alert" size={12} /> {error}</p>}
    </form>
  );
}

export function AssistantEmbedCard() {
  const q = useAssistantSettings();
  const [editing, setEditing] = useState<MarkedAgent | 'new' | null>(null);
  const [tab, setTab] = useState('node');
  if (q.isPending) return <SkeletonBlock label="Loading the embedded assistant settings" />;
  if (q.isError) return <ErrorState heading={3} title="The embedded assistant settings could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  const st = q.data;
  const first = st.agents.find((a) => a.enabled) ?? st.agents[0];
  const input = { server: window.location.origin, org: st.org, agentId: first?.agentId, columns: [...new Set((first?.datasets ?? []).map((d) => d.column))] };
  const code = { node: nodeAssistantSnippet(input), python: pythonAssistantSnippet(input), html: iframeSnippet() };
  return (
    <section className={s.card} aria-label="Embedded Assistant">
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}><Icon name="message-square" size={16} /> Embed the Assistant</h3>
        {st.agents.some((a) => a.enabled) ? <Badge tone="ok">On</Badge> : <Badge tone="neutral">Off</Badge>}
      </div>
      <p className={s.lead}>
        Put “Ask about your data” inside your own product. Your backend signs a short link (up to 1 hour) that names the agent, your customer’s id and the rows they may see; every
        answer is computed from that customer’s rows only, and nothing they ask is saved.
      </p>
      <div className={m.notice} role="note">
        <Icon name="eye" size={16} />
        <p>
          <strong>What customers can see.</strong> The names of the datasets and columns you mark, your notes on them, and the agent’s instructions are shown to every customer. Do not put a
          customer’s name in them. Project instructions, documents, verified questions and sample values are never shown to embedded customers.
        </p>
      </div>
      {!st.canStore && <p className={s.warn}><Icon name="lock" size={12} /> Needs a database and ORDINATE_MASTER_KEY on the server.</p>}
      {st.canStore && !st.embeddingOn && <p className={s.warn}><Icon name="alert" size={12} /> Embedding is off above. Turn it on, with a signing secret and your site, before links work.</p>}
      {st.agents.length === 0 && editing === null && <p className={s.originsEmpty}>No agent is embeddable yet. Mark an agent and the datasets it may answer from, each with the column that holds your customer’s id.</p>}
      <ul className={m.agents} aria-label="Embeddable agents">
        {st.agents.map((a) => <AgentRow key={a.agentId} a={a} onEdit={() => setEditing(a)} />)}
      </ul>
      {editing ? (
        <MarkForm key={editing === 'new' ? 'new' : editing.agentId} st={st} initial={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />
      ) : (
        <div><Button icon="plus" disabled={!st.canStore} onClick={() => setEditing('new')}>Mark an agent</Button></div>
      )}
      <h4 className={m.sub}>Caps</h4>
      <Caps key={`${st.caps.daily}/${st.caps.perMinute}`} st={st} />
      <h4 className={m.sub}>Sign a link on your server</h4>
      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="Assistant code">
          <Tab value="node" icon="code">Node</Tab>
          <Tab value="python" icon="terminal">Python</Tab>
          <Tab value="html" icon="layout-dashboard">Page</Tab>
        </TabList>
        {(['node', 'python', 'html'] as const).map((k) => (
          <TabPanel key={k} value={k}>
            <div className={s.codeBox}>
              <div className={s.codeHead}>
                <span className={s.codeFile}>{k === 'node' ? 'assistant-url.js' : k === 'python' ? 'assistant_url.py' : 'page.html'}</span>
                <Button size="sm" variant="ghost" icon="copy" onClick={() => copy(code[k], 'The code')} aria-label={`Copy the ${k} code`}>Copy</Button>
              </div>
              <pre className={s.code} data-testid={`assistant-snippet-${k}`}>{code[k]}</pre>
            </div>
          </TabPanel>
        ))}
      </Tabs>
    </section>
  );
}
