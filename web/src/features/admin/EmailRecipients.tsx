// Who an email channel names: the organization's teams and people, picked from
// the admin lists — never a typed address. Whether each one RECEIVES a given
// send is the server's decision at that moment (can they read the project?),
// so this only says whom the list names.

import { useState } from 'react';
import { Checkbox } from '../../ui/Choice';
import { Input } from '../../ui/Field';
import { SkeletonTable } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import type { EmailTo } from '../subscriptions/api';
import { useAdminUsers, useTeams } from './api';
import c from './Channels.module.css';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "3 people · 1 team" — what a list names. */
export function recipientsText(to: EmailTo | undefined): string {
  const parts = [to?.userIds.length ? plural(to.userIds.length, 'person', 'people') : '', to?.teamIds.length ? plural(to.teamIds.length, 'team', 'teams') : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nobody yet';
}

export function EmailRecipients({ value, onChange, error }: { value: EmailTo; onChange: (v: EmailTo) => void; error?: string }) {
  const users = useAdminUsers();
  const teams = useTeams();
  const [q, setQ] = useState('');
  const toggle = (key: keyof EmailTo, id: string, on: boolean): void => onChange({ ...value, [key]: on ? [...value[key], id] : value[key].filter((x) => x !== id) });

  let lists;
  if (users.isPending || teams.isPending) lists = <SkeletonTable cols={1} rows={4} label="Loading people and teams" />;
  else if (users.isError || teams.isError) {
    lists = <ErrorState compact heading={3} title="People and teams could not be loaded" message={(users.error ?? teams.error)?.message ?? ''} onRetry={() => { void users.refetch(); void teams.refetch(); }} />;
  } else {
    const needle = q.trim().toLowerCase();
    const groups = teams.data.filter((t) => !needle || t.name.toLowerCase().includes(needle));
    const people = users.data.filter((u) => !u.disabled && (!needle || u.email.includes(needle)));
    lists = (
      <div className={c.pickerLists}>
        <section className={c.pickerGroup} aria-label="Teams">
          <h4 className={c.pickerHead}>Teams</h4>
          {groups.length === 0 ? (
            <p className={c.pickerEmpty}>{needle ? 'No team matches.' : 'No teams yet — make them in Admin → Teams.'}</p>
          ) : (
            groups.map((t) => (
              <Checkbox key={t.id} label={t.name} hint={plural(t.members.length, 'member', 'members')} checked={value.teamIds.includes(t.id)} onCheckedChange={(on) => toggle('teamIds', t.id, on)} />
            ))
          )}
        </section>
        <section className={c.pickerGroup} aria-label="People">
          <h4 className={c.pickerHead}>People</h4>
          {people.length === 0 ? (
            <p className={c.pickerEmpty}>No one matches.</p>
          ) : (
            people.map((u) => (
              <Checkbox
                key={u.id}
                label={u.email}
                hint={u.pending ? 'Invited — receives once they have signed in' : undefined}
                checked={value.userIds.includes(u.id)}
                onCheckedChange={(on) => toggle('userIds', u.id, on)}
              />
            ))
          )}
        </section>
      </div>
    );
  }

  return (
    <fieldset className={c.picker} aria-describedby="email-recipients-summary">
      <legend className={c.pickerLegend}>Recipients</legend>
      <Input label="Find people or teams" value={q} placeholder="A name or an address" autoComplete="off" spellCheck={false} onChange={(e) => setQ(e.target.value)} />
      {lists}
      <p id="email-recipients-summary" className={c.pickerSummary}>
        {value.userIds.length + value.teamIds.length > 0
          ? `Names ${recipientsText(value)}. Each send reaches only those who can open the dashboard’s project at that moment.`
          : 'Pick at least one person or team.'}
      </p>
      {error && (
        <p className={c.pickerError} role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
