// An Assistant agent's page in the Data model's Assistant tab (docs/assistant-agents/00-design.md, "An agent's page"):
// its name, description, topic, model, what it may do and its teams — a project admin's to change (rule 5) — then its
// instructions, which an editor changes too, one at a time, by the project instructions' rules. A save goes through the
// edit-conflict guard; a 409 shows the house banner. Who may use it, and everything it answers, are the server's.

import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { Button, IconButton } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { ConfirmDelete } from '../../../ui/ConfirmDelete';
import { Input, Textarea } from '../../../ui/Field';
import { Icon } from '../../../ui/icons/Icon';
import { Select } from '../../../ui/Select';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { failure } from '../../analyses/api';
import { useAiStatus, type AiModel } from '../../assistant/api';
import { agentsKey, useAgents, type AgentRow } from '../../assistant/agents';
import { ConflictBanner } from '../../editConflicts/ConflictBanner';
import { useEditGuard } from '../../editConflicts/useEditGuard';
import { useShareTargets } from '../../projects/api';
import { toastMovedToTrash } from '../../projects/trashToast';
import { useNavigation } from '../../model/navigation';
import { suitesKey } from '../../evals/api';
import { TestsSection } from '../../evals/TestsSection';
import { InstructionsEditor } from './InstructionsList';
import { KnowledgeSection } from './KnowledgeSection';
import { SlackChannels } from './SlackChannels';
import type { InstructionOp } from './api';
import a from './Assistant.module.css';
import g from './Agents.module.css';

type Field = 'name' | 'topicId' | 'model' | 'teamIds' | 'form';
type SaveReply = { ok: true; agent: { id: string; name: string }; tag: string } | { ok: false; error: string; field?: Field };

const NONE = '';
const modelKey = (m: { provider: string; model: string } | null | undefined): string => (m ? `${m.provider}/${m.model}` : NONE);

export interface AgentPageProps {
  projectId: string;
  /** An agent's id, or 'new'. */
  id: string;
  onBack: () => void;
  /** A new agent was saved: its page from now on. */
  onCreated: (id: string) => void;
}

/** The page, and its Reload after a conflict: the list read again, in a new form. */
export function AgentPage(props: AgentPageProps) {
  const q = useAgents(props.projectId);
  const [gen, setGen] = useState(0);
  const back = (
    <button type="button" className={g.back} onClick={props.onBack}>
      <Icon name="chevron-left" size={16} />
      All assistants
    </button>
  );
  if (q.isPending) {
    return (
      <div className={g.page}>
        {back}
        <div className={a.card}>
          <div className={g.pending}>
            <SkeletonRows rows={6} label="Loading the assistant" />
          </div>
        </div>
      </div>
    );
  }
  if (q.isError) return <div className={g.page}>{back}<ErrorState heading={3} title="The assistant could not be opened" message={q.error.message || 'Try again.'} onRetry={() => void q.refetch()} /></div>;
  const row = props.id === 'new' ? undefined : q.data.agents.find((x) => x.id === props.id);
  if (props.id !== 'new' && !row) {
    return (
      <div className={g.page}>
        {back}
        <div className={a.card}>
          <EmptyState icon="sparkles" heading={3} title="This assistant no longer exists" actions={<Button onClick={props.onBack}>All assistants</Button>}>
            It may have been deleted. A project admin can bring it back from the Trash, with its conversations.
          </EmptyState>
        </div>
      </div>
    );
  }
  const reload = () => void q.refetch().then(() => setGen((n) => n + 1));
  return (
    <AgentForm key={`${props.id}:${gen}`} {...props} row={row} canManage={q.data.canManage} canInstruct={q.data.canInstruct} back={back} onReload={reload} />
  );
}

function AgentForm({ projectId, row, canManage, canInstruct, back, onBack, onCreated, onReload }: AgentPageProps & { row?: AgentRow; canManage: boolean; canInstruct: boolean; back: ReactNode; onReload: () => void }) {
  const client = useQueryClient();
  const status = useAiStatus();
  const nav = useNavigation(projectId);
  const targets = useShareTargets(projectId, canManage);
  const guard = useEditGuard({ projectId, type: 'agent', id: row?.id }, row?.tag);
  const [name, setName] = useState(row?.name ?? '');
  const [description, setDescription] = useState(row?.description ?? '');
  const [topicId, setTopicId] = useState(row?.topic?.id ?? NONE);
  const [model, setModel] = useState(modelKey(row?.model));
  const [build, setBuild] = useState(row?.build ?? false);
  const [teams, setTeams] = useState(row?.teams ?? []);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const isNew = !row;
  const models: readonly AiModel[] = status.data?.models ?? [];
  const topics = nav.data?.topics ?? [];
  const allTeams = targets.data?.teams ?? [];
  const modelGone = !!row?.model && !models.some((m) => modelKey(m) === modelKey(row.model));
  const dirty = isNew || name !== row.name || description !== (row.description ?? '') || topicId !== (row.topic?.id ?? NONE) || model !== modelKey(row.model)
    || build !== row.build || teams.map((t) => t.id).join() !== row.teams.map((t) => t.id).join();

  const agentInput = () => {
    const picked = models.find((m) => modelKey(m) === model);
    return {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      topicId: topicId || null,
      model: picked ? { provider: picked.provider, model: picked.model } : model && row?.model && model === modelKey(row.model) ? row.model : null,
      build,
      teamIds: teams.map((t) => t.id),
    };
  };
  const send = (base?: string) => rpc('agent:save', { projectId, ...(row ? { id: row.id } : {}), ...(base ? { base } : {}), agent: agentInput() }) as Promise<SaveReply>;
  const save = async () => {
    setErrors({});
    if (!name.trim()) return setErrors({ name: 'An assistant needs a name.' });
    setSaving(true);
    try {
      const r = row ? await guard.save(send) : await send();
      if (r === null) return; // the conflict banner
      if (!r.ok) return setErrors({ [r.field ?? 'form']: r.error });
      await client.invalidateQueries({ queryKey: agentsKey(projectId) });
      void client.invalidateQueries({ queryKey: suitesKey(projectId) }); // its tests may now be out of date: the Tests section says so
      if (isNew) onCreated(r.agent.id);
    } catch (err) {
      setErrors({ form: failure(err, 'The assistant could not be saved.') });
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!row) return;
    setAsking(false);
    const reply = (await rpc('agent:delete', { projectId, id: row.id }).catch(() => null)) as { ok?: boolean } | null;
    toastMovedToTrash(client, { projectId, type: 'agent', id: row.id, name: row.name }, reply);
    await client.invalidateQueries({ queryKey: agentsKey(projectId) });
    if (reply?.ok) onBack();
  };
  const change = async (op: InstructionOp): Promise<string | null> => {
    if (!row) return 'Save the assistant first.';
    let r: { ok: boolean; error?: string };
    try {
      r = (await rpc('agent:instructions', { projectId, id: row.id, op })) as { ok: boolean; error?: string };
    } catch {
      return 'Could not save the instruction.';
    }
    if (!r.ok) return r.error || 'Could not save the instruction.';
    await client.invalidateQueries({ queryKey: agentsKey(projectId) });
    void client.invalidateQueries({ queryKey: suitesKey(projectId) });
    return null;
  };

  const topicName = row?.topic?.name;
  const modelName = (m: AiModel) => m.label || m.model;
  const free = allTeams.filter((t) => !teams.some((x) => x.id === t.id));
  return (
    <div className={g.page} data-testid="agent-page">
      {back}
      <div className={g.top}>
        <span className={`${g.mark} ${g.topMark} ${g.tone0}`} aria-hidden="true">
          {(name.trim() || 'N').charAt(0).toUpperCase()}
        </span>
        <div className={g.topText}>
          <h2 className={g.topName}>{isNew ? 'New agent' : row.name}</h2>
          <p className={g.topDesc}>{isNew ? 'The Assistant, set up for one team. It only narrows what people can already read.' : row.description || (topicName ? `Answers from the ${topicName} topic` : 'Answers from all data')}</p>
        </div>
        {canManage && row && (
          <div className={g.topActions}>
            <Button icon="trash" onClick={() => setAsking(true)}>
              Delete
            </Button>
          </div>
        )}
      </div>
      {guard.changed && <ConflictBanner noun="assistant" onReload={onReload} />}

      <section className={a.section} aria-labelledby="agent-settings-h">
        <div className={a.head}>
          <div>
            <h3 className={a.title} id="agent-settings-h">
              Settings
            </h3>
            <p className={a.sub}>{canManage ? 'What it answers from, who uses it and what it may do.' : canInstruct ? 'A project admin sets these. You can change its instructions below.' : 'A project admin sets these.'}</p>
          </div>
        </div>
        <div className={a.card}>
          <dl className={g.grid}>
            <dt className={g.label}>Name</dt>
            <dd className={g.value}>
              {canManage ? <Input className={g.control} aria-label="Name" placeholder="Finance assistant" value={name} error={errors.name} maxLength={80} autoFocus={isNew} onChange={(e) => setName(e.target.value)} /> : <span className={g.readOnly}>{row?.name}</span>}
            </dd>
            <dt className={g.label}>Description</dt>
            <dd className={g.value}>
              {canManage ? (
                <Textarea className={g.control} aria-label="Description" placeholder="Invoices, costs and payroll" rows={2} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
              ) : (
                <span className={g.readOnly}>{row?.description || '—'}</span>
              )}
            </dd>
            <dt className={g.label}>Topic</dt>
            <dd className={g.value}>
              {canManage ? (
                <span className={g.control}>
                  <Select aria-label="Topic" value={topicId} error={errors.topicId} onValueChange={setTopicId} options={[{ value: NONE, label: 'None — all data' }, ...topics.map((t) => ({ value: t.id, label: t.name }))]} />
                </span>
              ) : (
                <span className={g.readOnly}>{topicName ?? 'None — all data'}</span>
              )}
              {row?.topicGone && (
                <p className={g.warnLine}>
                  <Icon name="alert" size={12} />
                  Its topic was deleted: it answers from all data until another is picked.
                </p>
              )}
              <p className={g.help}>{topics.length ? 'It answers from the topic’s datasets, metrics and terms only. None means all the data each person can read.' : 'No topic yet: make one in the header’s topic menu. None means all the data each person can read.'}</p>
            </dd>
            <dt className={g.label}>Model</dt>
            <dd className={g.value}>
              {canManage ? (
                <span className={g.control}>
                  <Select
                    aria-label="Model"
                    value={model}
                    error={errors.model}
                    onValueChange={setModel}
                    options={[{ value: NONE, label: 'Each person’s own' }, ...models.map((m) => ({ value: modelKey(m), label: modelName(m) })), ...(modelGone && row?.model ? [{ value: modelKey(row.model), label: `${row.model.model} (no longer enabled)`, disabled: true }] : [])]}
                  />
                </span>
              ) : (
                <span className={g.readOnly}>{row?.model ? (models.find((m) => modelKey(m) === modelKey(row.model))?.label ?? row.model.model) : 'Each person’s own'}</span>
              )}
              {modelGone && (
                <p className={g.warnLine}>
                  <Icon name="alert" size={12} />
                  Its model is no longer enabled in Admin → AI: each person’s own answers.
                </p>
              )}
              <p className={g.help}>Set, it answers everyone in this assistant. Empty, each person’s own pick does.</p>
            </dd>
            <dt className={g.label}>Can</dt>
            <dd className={g.value}>
              <span className={g.checks}>
                <Checkbox label="Answer questions" hint="Always on" checked disabled onCheckedChange={() => undefined} />
                <Checkbox label="Build charts and dashboards" hint="Plans, drafts and imports" checked={build} disabled={!canManage} onCheckedChange={setBuild} />
              </span>
              <p className={g.help}>It never raises anyone’s role: a viewer still cannot build, whatever it allows.</p>
            </dd>
            <dt className={g.label}>Teams</dt>
            <dd className={g.value}>
              <span className={g.chips} aria-label="Teams">
                {teams.map((t) => (
                  <span key={t.id} className={canManage ? g.chip : `${g.chip} ${g.chipReadOnly}`}>
                    {t.name}
                    {canManage && <IconButton icon="x" size="sm" label={`Remove ${t.name}`} onClick={() => setTeams(teams.filter((x) => x.id !== t.id))} />}
                  </span>
                ))}
                {!teams.length && !canManage && <span className={g.readOnly}>No team yet</span>}
                {canManage && free.length > 0 && (
                  <span className={g.addTeam}>
                    <Select
                      size="sm"
                      aria-label="Add team"
                      placeholder="+ Add team"
                      value={null}
                      options={free.map((t) => ({ value: t.id, label: t.name }))}
                      onValueChange={(v) => {
                        const t = free.find((x) => x.id === v);
                        if (t) setTeams([...teams, t]);
                      }}
                    />
                  </span>
                )}
              </span>
              {errors.teamIds && (
                <p className={a.error} role="alert">
                  {errors.teamIds}
                </p>
              )}
              <p className={g.help}>
                {canManage && !allTeams.length && !targets.isPending ? 'No teams in this organization yet: an org admin makes them in Admin → People. ' : ''}
                Its teams find it picked for them. The project's editors and admins can use every assistant, to try it first.
              </p>
            </dd>
            {canManage && row && (
              <>
                <dt className={g.label}>Slack channels</dt>
                <dd className={g.value}>
                  <SlackChannels projectId={projectId} agentId={row.id} />
                </dd>
              </>
            )}
          </dl>
          {canManage && (
            <div className={g.formFoot}>
              {errors.form && (
                <p className={g.formError} role="alert">
                  {errors.form}
                </p>
              )}
              {isNew && <Button onClick={onBack}>Cancel</Button>}
              <Button variant="primary" icon="check" loading={saving} disabled={guard.changed || !dirty} onClick={() => void save()}>
                {isNew ? 'Create agent' : 'Save'}
              </Button>
            </div>
          )}
        </div>
      </section>

      {row ? (
        <InstructionsEditor
          source={{ isPending: false, isError: false, error: null, data: row.instructions ?? [], refetch: () => undefined }}
          change={change}
          canEdit={canInstruct}
          headingId="agent-instructions-h"
          title="Instructions"
          sub="Read after the project’s instructions. Where the two disagree, these win."
          empty={{
            editor: `Write what this team means by its words, like “Revenue means recognized revenue” or “Our year starts in February”. The project’s instructions still apply first.`,
            reader: 'The rules this team follows go here. An editor of this project can add them.',
          }}
          foot={`${row.name} reads the project’s instructions, then these, before every answer. They shape its choices and words; every figure still comes from your data.`}
        />
      ) : (
        <p className={g.help}>Create the agent first, then write its own instructions here.</p>
      )}

      {row && <KnowledgeSection projectId={projectId} agentId={row.id} canEdit={canInstruct} instructionsId="agent-instructions-h" />}

      {row && canInstruct && <TestsSection projectId={projectId} agentId={row.id} />}

      {asking && row && (
        <ConfirmDelete
          title={`Delete “${row.name}”?`}
          description="It moves to the Trash for 30 days. Its conversations stay readable, and new questions in them go to the Project assistant. Restoring it brings it back."
          onConfirm={() => void remove()}
          onClose={() => setAsking(false)}
        />
      )}
    </div>
  );
}
