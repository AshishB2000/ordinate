// The org's people and teams as access rules name them (row rules, RowAccessTab; column rules,
// ColumnAccessSection): one option list from the project's share targets, a name for a member, and a
// picker of several members as chips.

import { useMemo } from 'react';
import { IconButton } from '../../ui/Button';
import { Combobox } from '../../ui/Combobox';
import { useShareTargets } from '../projects/api';
import type { RuleMember } from './rowAccessApi';
import s from './RowAccess.module.css';

/** `user:<id>` / `team:<id>`: one string per member, for pickers and keys. */
export const memberKey = (m: RuleMember): string => ('userId' in m ? `user:${m.userId}` : `team:${m.teamId}`);
export const memberOf = (key: string): RuleMember => {
  const [kind, id] = key.split(':') as ['user' | 'team', string];
  return kind === 'user' ? { userId: id } : { teamId: id };
};

/** The options (`HR (team)`, `ana@acme.test`), and each member's plain name (a team's name, a user's email). */
export function useMembers(projectId: string) {
  const targets = useShareTargets(projectId, true);
  const options = useMemo(() => [
    ...(targets.data?.teams ?? []).map((t) => ({ value: `team:${t.id}`, label: `${t.name} (team)` })),
    ...(targets.data?.users ?? []).map((u) => ({ value: `user:${u.id}`, label: u.email })),
  ], [targets.data]);
  const names = useMemo(() => new Map<string, { name: string; team: boolean }>([
    ...(targets.data?.teams ?? []).map((t) => [`team:${t.id}`, { name: t.name, team: true }] as const),
    ...(targets.data?.users ?? []).map((u) => [`user:${u.id}`, { name: u.email, team: false }] as const),
  ]), [targets.data]);
  const nameOf = (m: RuleMember): string => names.get(memberKey(m))?.name ?? 'someone no longer in this org';
  return { targets, options, nameOf, isTeam: (m: RuleMember) => names.get(memberKey(m))?.team ?? false };
}

/** Several members as chips, and a search to add one. */
export function MemberPicker({ projectId, value, onChange }: { projectId: string; value: RuleMember[]; onChange: (v: RuleMember[]) => void }) {
  const { targets, options, nameOf, isTeam } = useMembers(projectId);
  const picked = new Set(value.map(memberKey));
  return (
    <div className={s.values}>
      <ul className={s.chips} aria-label="Who can see it">
        {value.map((m) => (
          <li key={memberKey(m)} className={s.chip}>
            <span>{nameOf(m)}</span>
            {isTeam(m) && <span className={s.none}>team</span>}
            <IconButton icon="x" size="sm" label={`Remove ${nameOf(m)}`} onClick={() => onChange(value.filter((x) => memberKey(x) !== memberKey(m)))} />
          </li>
        ))}
        {!value.length && <li className={s.none}>No one yet: every viewer is refused it. Editors and admins still see it.</li>}
      </ul>
      <Combobox
        aria-label="Add a person or team"
        placeholder={targets.isPending ? 'Loading…' : 'Search people and teams'}
        value={null}
        onValueChange={(k) => !picked.has(k) && onChange([...value, memberOf(k)])}
        options={options.filter((o) => !picked.has(o.value))}
        emptyText="No more people or teams"
        disabled={targets.isPending}
      />
    </div>
  );
}
