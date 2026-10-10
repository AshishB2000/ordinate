// The command palette (⌘K / Ctrl+K) and the keyboard shortcuts sheet (?) —
// palette.ts, ported. One box that reaches everything: the commands in the
// registry and the records in the current project. Prefixes: `>` commands
// only, `/` records only. The keymap is here too: the ONE keydown handler that
// runs registry shortcuts (a page declares `keys` on its command, it does not
// bind them).
//
// Mounted once by the shell. Radix Dialog gives the focus trap, Escape and
// focus back to where it was; the scrim is ours (Radix's Overlay injects a
// <style> the CSP refuses — see ui/Dialog.tsx).

import { useEffect, useId, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import * as D from '@radix-ui/react-dialog';
import { useThemePref } from '../../app/theme';
import { useRecent } from '../../api/home';
import { itemHref, TYPE_LABEL } from '../home/homeText';
import { useMe } from '../auth/api';
import { setDockOpen, useDockOpen } from '../assistant/dockState';
import { useCurrentProject } from '../projects/current';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { appCommands } from './appCommands';
import { HIT_ICON, hitHref, useRecordSearch } from './records';
import { GROUPS, commandForKey, inTextField, keyToken, runCommand, searchCommands, useCommands, useRegistryVersion, type Command } from './registry';
import { KeyCaps, ShortcutsSheet } from './ShortcutsSheet';
import s from './Palette.module.css';

const MAX_COMMANDS = 8;
const DEBOUNCE_MS = 120;
/** Chords a text field owns: ⌘Z in a textarea is "undo my typing". */
const NATIVE_EDIT = new Set(['z', 'y', 'x', 'c', 'v', 'a']);

interface Row {
  key: string;
  icon: IconName;
  title: string;
  sub?: string;
  keys?: string;
  run: () => void;
}
interface Section {
  label: string;
  rows: Row[];
}

function useDebounced(v: string, ms: number): string {
  const [out, setOut] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setOut(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return out;
}

function commandRow(c: Command, close: () => void): Row {
  return {
    key: 'cmd:' + c.id,
    icon: c.icon,
    title: c.title,
    sub: c.group,
    keys: c.keys,
    run: () => {
      close();
      runCommand(c.id);
    },
  };
}

function PaletteBox({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();
  const { projectId, project } = useCurrentProject();
  const version = useRegistryVersion();
  const recent = useRecent();
  const mode = query.startsWith('>') ? 'commands' : query.startsWith('/') ? 'records' : 'all';
  const text = mode === 'all' ? query : query.slice(1);
  const typed = useDebounced(text, DEBOUNCE_MS);
  const search = useRecordSearch(mode === 'commands' ? null : projectId, typed);
  const listId = useId();

  const sections = useMemo<Section[]>(() => {
    void version; // the registry changed: list again
    const go = (to: string) => () => {
      onClose();
      void navigate(to);
    };
    const out: Section[] = [];
    if (mode !== 'commands') {
      if (!text.trim()) {
        const rows = (recent.data ?? []).slice(0, 6).map<Row>((it) => ({
          key: `rec:${it.type}:${it.id}`,
          icon: it.type === 'dataset' ? 'database' : it.type === 'analysis' ? 'layout-dashboard' : it.type === 'capture' ? 'camera' : it.type === 'visual' ? 'chart-bar' : 'file-text',
          title: it.name,
          sub: `${TYPE_LABEL[it.type]} · ${it.projectName}`,
          run: go(itemHref(it)),
        }));
        out.push({ label: 'Recent', rows });
      } else {
        const rows = (search.data ?? []).map<Row>((h) => ({
          key: `hit:${h.kind}:${h.id}`,
          icon: HIT_ICON[h.kind] ?? 'file-text',
          title: h.name,
          sub: h.sub ? `${h.type} · ${h.sub}` : h.type,
          run: go(hitHref(h)),
        }));
        out.push({ label: project ? `In ${project.name}` : 'Records', rows });
      }
    }
    if (mode !== 'records') {
      const found = searchCommands(text);
      if (text.trim()) out.push({ label: 'Commands', rows: found.slice(0, MAX_COMMANDS).map((c) => commandRow(c, onClose)) });
      else for (const g of GROUPS) out.push({ label: g, rows: found.filter((c) => c.group === g).map((c) => commandRow(c, onClose)) });
    }
    return out.filter((x) => x.rows.length);
  }, [mode, text, recent.data, search.data, project, navigate, onClose, version]);

  const flat = sections.flatMap((x) => x.rows);
  const at = Math.min(sel, Math.max(0, flat.length - 1));
  const active = flat[at];
  useEffect(() => {
    if (active) document.getElementById(`${listId}-${at}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, at, listId]);

  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!flat.length) return;
      setSel((at + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setSel(e.key === 'Home' ? 0 : flat.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      active?.run();
    }
  };

  const busy = mode !== 'commands' && text.trim() !== '' && (search.isFetching || typed !== text);
  const empty = !flat.length && !busy;
  let i = -1;
  return (
    <>
      <div className={s.inputRow}>
        <Icon name="search" />
        <input
          className={s.input}
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active ? `${listId}-${at}` : undefined}
          aria-label="Search commands and records"
          placeholder={projectId ? 'Type a command, or search this project…' : 'Type a command…'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKey}
          spellCheck={false}
          autoComplete="off"
        />
        {busy && (
          <span className={s.spin}>
            <Icon name="loader" />
          </span>
        )}
      </div>
      <div className={s.results} id={listId} role="listbox" aria-label="Results" aria-busy={busy}>
        {empty && (
          <div className={s.empty}>
            <strong>Nothing matches “{text.trim()}”</strong>
            <span>{mode === 'records' ? 'Record names are searched in the current project.' : 'Try fewer letters, or > for commands only and / for records only.'}</span>
          </div>
        )}
        {search.isError && mode !== 'commands' && <div className={s.note}>Records could not be searched: {search.error.message}</div>}
        {sections.map((sec) => (
          <div key={sec.label} role="group" aria-label={sec.label}>
            <div className={s.heading} aria-hidden="true">
              {sec.label}
            </div>
            {sec.rows.map((r) => {
              i++;
              const n = i;
              return (
                <div
                  key={r.key}
                  id={`${listId}-${n}`}
                  role="option"
                  aria-selected={n === at}
                  className={n === at ? `${s.row} ${s.on}` : s.row}
                  onMouseMove={() => n !== at && setSel(n)}
                  onClick={r.run}
                >
                  <Icon name={r.icon} />
                  <span className={s.title}>{r.title}</span>
                  {r.sub && <span className={s.sub}>{r.sub}</span>}
                  {r.keys && <KeyCaps keys={r.keys} />}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className={s.foot} aria-hidden="true">
        <span>
          <KeyCaps keys="arrowup" /> <KeyCaps keys="arrowdown" /> move
        </span>
        <span>
          <KeyCaps keys="enter" /> run
        </span>
        <span>
          <b>&gt;</b> commands · <b>/</b> records
        </span>
      </div>
    </>
  );
}

let opener: (() => void) | null = null;

/** Opens the palette — the top bar's Search box is its door for a pointer. */
export function openPalette(e?: { preventDefault(): void }): void {
  e?.preventDefault();
  opener?.();
}

/** The palette, the shortcuts sheet, the app-wide commands and the keymap. Mount once. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const navigate = useNavigate();
  const me = useMe();
  const [theme, setTheme] = useThemePref();
  const dockOpen = useDockOpen();
  const role = me.data?.user?.role;

  useCommands(
    useMemo(
      () =>
        appCommands({
          go: (to) => void navigate(to),
          role,
          theme,
          setTheme,
          dockOpen,
          setDockOpen,
          togglePalette: () => setOpen((o) => !o),
          openShortcuts: () => setSheet(true),
        }),
      [navigate, role, theme, setTheme, dockOpen],
    ),
  );

  useEffect(() => {
    opener = () => setOpen(true);
    return () => {
      opener = null;
    };
  }, []);

  // The keymap. Capture phase, so a focused textarea cannot swallow a ⌘ chord.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const token = keyToken(e);
      if (!token) return;
      // An open palette owns the keyboard; its own chord puts it away again.
      if (open) {
        if (token === 'mod+k') {
          e.preventDefault();
          setOpen(false);
        }
        return;
      }
      const cmd = commandForKey(token);
      if (!cmd) return;
      const chord = token.startsWith('mod+');
      if ((!chord || NATIVE_EDIT.has(token.split('+').pop() as string)) && inTextField(e.target)) return;
      // A plain key ('?') never fires over another dialog either.
      if (!chord && document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      runCommand(cmd.id);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  return (
    <>
      <D.Root open={open} onOpenChange={setOpen}>
        <D.Portal>
          <div className={s.scrim} />
          <D.Content className={s.palette} aria-describedby={undefined}>
            <D.Title className={s.srOnly}>Command palette</D.Title>
            <PaletteBox onClose={() => setOpen(false)} />
          </D.Content>
        </D.Portal>
      </D.Root>
      <ShortcutsSheet open={sheet} onOpenChange={setSheet} />
    </>
  );
}
