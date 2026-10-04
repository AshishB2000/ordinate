// Organization → Themes — themeSettings.ts, ported: the workspace default, the
// org's own themes (edit, duplicate, delete with an inline confirm), and the
// built-in presets as read-only starting points. The editor replaces the list
// while it is open, as on the desktop. Every write goes through the server,
// which validates and answers; the list repaints from that answer.

import { useState, type ReactNode } from 'react';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { useThemes, useWrite, type ThemeRecord, type ThemeState } from './api';
import { Group, Row } from './Rows';
import { ThemeEditor, type Draft } from './ThemeEditor';
import { ThemeThumb } from './ThemePreview';
import { BUILTINS } from './themeBuiltins';
import { summary, type Tokens } from './themeModel';
import s from './Settings.module.css';
import t from './Themes.module.css';

const LIST = [['themes:list']] as const;

/** A name nobody in the list has yet: "Copy of Light", "Copy of Light 2", … */
function uniqueName(base: string, themes: readonly ThemeRecord[]): string {
  let name = base;
  for (let i = 2; themes.some((x) => x.name === name); i++) name = `${base} ${i}`;
  return name;
}

function Item({ name, note, tokens, badge, actions, confirm }: { name: string; note: string; tokens: Tokens; badge?: string; actions: ReactNode; confirm?: boolean }) {
  return (
    <div className={confirm ? `${t.item} ${t.confirm}` : t.item} role="listitem" aria-label={name}>
      {!confirm && <ThemeThumb tokens={tokens} />}
      <div className={t.itemMain}>
        <span className={t.itemName}>
          {name}
          {badge && <Badge tone={badge === 'Read-only' ? 'neutral' : 'accent'}>{badge}</Badge>}
        </span>
        <span className={t.itemNote}>{note}</span>
      </div>
      <div className={t.itemActions}>{actions}</div>
    </div>
  );
}

function ThemeList({ state, onEdit }: { state: ThemeState; onEdit: (d: Draft) => void }) {
  const [confirm, setConfirm] = useState('');
  const setDefault = useWrite('themes:setDefault', LIST);
  const remove = useWrite('themes:delete', LIST, (r) => r.ok && toast('Theme deleted.'));
  const dup = useWrite<'themes:save', { ok: boolean; theme?: ThemeRecord }>('themes:save', LIST, (r) => r.ok && r.theme && toast(`Duplicated as “${r.theme.name}”.`, { kind: 'success' }));
  const duplicate = (name: string, tokens: Tokens) => dup.mutate({ name: uniqueName(`Copy of ${name}`, state.themes), tokens });
  return (
    <div className={s.stackPage}>
      <Group title="Workspace theme" desc="Colours, fonts and card style every dashboard in the organization wears — unless its own Style panel picks another.">
        <Row title="Every dashboard wears" desc={state.themes.length ? undefined : 'Make a theme below first.'}>
          <div className={s.select}>
            <Select
              aria-label="Workspace theme"
              value={state.defaultId}
              disabled={!state.themes.length}
              onValueChange={(v) => setDefault.mutate(v)}
              options={[{ value: '', label: 'None — each dashboard’s own style' }, ...state.themes.map((x) => ({ value: x.id, label: x.name }))]}
            />
          </div>
        </Row>
      </Group>
      <Group title={`Your themes · ${state.themes.length}`} desc="Yours first: what this page is for. Duplicate a built-in to start one.">
        <div className={t.list} role="list" aria-label="Your themes">
          {state.themes.length === 0 && (
            <div className={t.empty}>
              <span className={t.emptyIcon}>
                <Icon name="layers" size={20} />
              </span>
              <span>
                <strong>No themes of your own yet</strong>
                Duplicate a built-in below, then edit the copy.
              </span>
            </div>
          )}
          {state.themes.map((x) =>
            confirm === x.id ? (
              <Item
                key={x.id}
                confirm
                name={`Delete “${x.name}”?`}
                note="Dashboards that use it fall back to the workspace theme, or their own style."
                tokens={x.tokens}
                actions={
                  <>
                    <Button size="sm" onClick={() => setConfirm('')}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="danger" icon="trash" loading={remove.isPending} onClick={() => remove.mutate(x.id, { onSettled: () => setConfirm('') })}>
                      Delete
                    </Button>
                  </>
                }
              />
            ) : (
              <Item
                key={x.id}
                name={x.name}
                note={summary(x.tokens)}
                tokens={x.tokens}
                badge={x.id === state.defaultId ? 'Workspace default' : undefined}
                actions={
                  <>
                    <Button size="sm" icon="pencil" onClick={() => onEdit({ id: x.id, name: x.name, tokens: x.tokens })}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" icon="copy" onClick={() => duplicate(x.name, x.tokens)} aria-label={`Duplicate ${x.name}`}>
                      Duplicate
                    </Button>
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirm(x.id)} aria-label={`Delete ${x.name}`}>
                      Delete
                    </Button>
                  </>
                }
              />
            ),
          )}
        </div>
      </Group>
      <Group title={`Built-in · ${BUILTINS.length}`} desc="The dashboard style presets. Read-only; a duplicate keeps their exact colours until you edit one.">
        <div className={t.list} role="list" aria-label="Built-in themes">
          {BUILTINS.map((b) => (
            <Item
              key={b.id}
              name={b.name}
              note={b.note}
              tokens={b.tokens}
              badge="Read-only"
              actions={
                <Button size="sm" icon="copy" loading={dup.isPending && dup.variables?.tokens === b.tokens} onClick={() => duplicate(b.name, b.tokens)} aria-label={`Duplicate ${b.name}`}>
                  Duplicate
                </Button>
              }
            />
          ))}
        </div>
      </Group>
    </div>
  );
}

export function ThemesTab() {
  const themes = useThemes();
  const [editing, setEditing] = useState<Draft | null>(null);
  if (themes.isPending) return <SkeletonRows rows={6} label="Loading themes" />;
  if (themes.isError) return <ErrorState heading={3} title="Themes could not be loaded" message={themes.error.message} onRetry={() => void themes.refetch()} />;
  if (editing) return <ThemeEditor start={editing} onClose={() => setEditing(null)} />;
  return <ThemeList state={themes.data} onEdit={setEditing} />;
}
