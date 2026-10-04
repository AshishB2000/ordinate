// Settings → Privacy, for the CURRENT project — privacySettings.ts, ported:
// the Share policy (what exports, reports, publish and bundles do with a
// column marked sensitive), the proposals waiting for review, the columns
// already marked, and where the masking key lives. Detection and masking are
// the server's (src/data/sensitivity.ts, src/app/sharePolicy.ts); the key
// never reaches a browser. Controls are offered by role: any member reads, an
// editor marks a column, a project admin changes the policy.

import { useCurrentProject } from '../projects/current';
import { useCan } from '../projects/api';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { usePrivacy, useWrite, type Level, type Proposal, type SharePath, type ShareAction } from './api';
import { Group, Row, Segmented } from './Rows';
import s from './Settings.module.css';

const PATHS: Array<{ key: SharePath; title: string; desc: string }> = [
  { key: 'export', title: 'Exports', desc: 'Dashboard and visual exports, exported data, Copy data.' },
  { key: 'report', title: 'Reports and stories', desc: 'Generated reports — scheduled ones too — and stories.' },
  { key: 'publish', title: 'Publish', desc: 'Dashboards published as a site or a link.' },
  { key: 'bundle', title: 'Project bundles', desc: '.ordinate files: a dataset with sensitive columns travels masked or without them.' },
];
const ACTIONS: Array<{ value: ShareAction; label: string; hint: string }> = [
  { value: 'mask', label: 'Mask', hint: 'Replace each value with this project’s token for it — joins still line up.' },
  { value: 'drop', label: 'Drop', hint: 'Leave the column out; hide a chart built on it.' },
  { value: 'include', label: 'Include', hint: 'Keep the values, and ask before every export that carries them.' },
];
const LEVEL: Record<Level, string> = { personal: 'Personal', financial: 'Financial' };
const KIND: Record<string, string> = {
  email: 'email addresses', phone: 'phone numbers', national_id: 'national ID numbers', card_number: 'card numbers',
  iban: 'bank account numbers', ip_address: 'IP addresses', street_address: 'street addresses', person_name: 'people’s names',
  birth_date: 'dates of birth', salary: 'pay or income',
};
export const proposalTitle = (p: Pick<Proposal, 'kind'>) => `Looks like ${KIND[p.kind] ?? 'sensitive data'}`;

export function PrivacySection() {
  const { projectId, project, status } = useCurrentProject();
  const can = useCan(projectId);
  const o = usePrivacy(projectId);
  const refresh = [['privacy:overview', projectId]] as const;
  const setPolicy = useWrite('privacy:setPolicy', refresh);
  const decide = useWrite('privacy:decide', refresh);
  const scan = useWrite<'privacy:scan', { ok: boolean; found: number }>('privacy:scan', refresh, (r) =>
    toast(r.found ? `${r.found} column${r.found === 1 ? '' : 's'} to review.` : 'Nothing new looks sensitive.'),
  );

  if (status === 'pending' || (projectId && o.isPending)) return <SkeletonRows rows={6} label="Loading privacy settings" />;
  if (!projectId) {
    return (
      <EmptyState icon="lock" title="Open a project to set what leaves it" heading={3}>
        The Share policy and the sensitive columns belong to a project. Pick one from the project switcher.
      </EmptyState>
    );
  }
  if (o.isError) return <ErrorState heading={3} title="Privacy settings could not be loaded" message={o.error.message} onRetry={() => void o.refetch()} />;
  const d = o.data;
  if (!d) return null;
  const admin = can('admin');
  const editor = can('editor');
  const pending = d.datasets.filter((x) => x.pending.length);
  const marked = d.datasets.filter((x) => x.sensitive.length);
  const pendingN = pending.reduce((n, x) => n + x.pending.length, 0);
  const markedN = marked.reduce((n, x) => n + x.sensitive.length, 0);
  const scanButton = (
    <Button size="sm" icon="search" disabled={!editor} loading={scan.isPending} onClick={() => scan.mutate({ projectId })}>
      Check {d.datasetCount} dataset{d.datasetCount === 1 ? '' : 's'} for sensitive columns
    </Button>
  );

  return (
    <div className={s.stackPage}>
      <Group
        title={`Share policy for ${project?.name ?? d.projectName}`}
        desc={
          <>
            What happens to columns marked personal or financial when data leaves Ordinate.{' '}
            {!admin && 'Only a project admin can change it.'}
          </>
        }
      >
        {PATHS.map((p) => (
          <Row key={p.key} title={p.title} desc={p.desc}>
            <Segmented label={p.title} value={d.policy[p.key]} disabled={!admin} options={ACTIONS} onChange={(v) => setPolicy.mutate({ projectId, policy: { [p.key]: v } })} />
          </Row>
        ))}
      </Group>

      {pendingN > 0 && (
        <Group title={`To review · ${pendingN}`} desc="Columns that look personal or financial. Nothing is marked until someone says so.">
          {pending.flatMap((x) =>
            x.pending.map((p) => (
              <Row key={`${x.id}:${p.column}`} title={`${p.column} · ${x.name}`} desc={`${proposalTitle(p)}. ${p.reason}`}>
                <Badge tone="warn">{LEVEL[p.level]}?</Badge>
                <Button size="sm" variant="primary" disabled={!editor} onClick={() => decide.mutate({ projectId, datasetId: x.id, column: p.column, level: p.level })}>
                  Mark as {p.level}
                </Button>
                <Button size="sm" disabled={!editor} onClick={() => decide.mutate({ projectId, datasetId: x.id, column: p.column, level: 'none' })}>
                  Not sensitive
                </Button>
              </Row>
            )),
          )}
        </Group>
      )}

      <Group title={markedN ? `Sensitive columns · ${markedN}` : 'Sensitive columns'} desc="Marked from a review, a column's details or Prepare. Every share path above applies to these.">
        {markedN === 0 ? (
          <EmptyState icon="shield" title="No columns are marked sensitive yet" heading={3} compact actions={d.datasetCount ? scanButton : undefined}>
            {d.datasetCount
              ? 'Ordinate flags likely personal and financial columns as data comes in. Datasets imported before that can be checked now.'
              : 'Import a dataset and Ordinate will flag columns that look personal or financial.'}
          </EmptyState>
        ) : (
          <>
            {marked.map((x) => (
              <Row key={x.id} title={x.name}>
                {x.sensitive.map((c) => (
                  <Badge key={c.column} tone={c.level === 'financial' ? 'warn' : 'accent'}>
                    {c.column} · {LEVEL[c.level]}
                    {c.maskedInPrepare ? ' · masked in Prepare' : ''}
                  </Badge>
                ))}
              </Row>
            ))}
            <div className={s.actionsRow}>{scanButton}</div>
          </>
        )}
      </Group>

      <Group title="Masking key">
        <Row title="Kept on the server, with this project" desc="Hash steps and masked exports use it, so the same value always becomes the same token within this project. It never reaches a browser and never travels in a bundle or a backup." />
      </Group>
    </div>
  );
}
