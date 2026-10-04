// The keyboard shortcuts sheet (?) — palette.ts's sheet: the SAME registry the
// palette and the keymap read, so a rebinding moves here with it. Also the
// list My settings shows.

import { Kbd } from '../../ui/Kbd';
import { Dialog } from '../../ui/Dialog';
import { GROUPS, keyCaps, keyLabel, listCommands, useRegistryVersion } from './registry';
import s from './Palette.module.css';

export function KeyCaps({ keys }: { keys: string }) {
  return (
    <span className={s.caps} aria-label={keyLabel(keys)}>
      {keyCaps(keys).map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </span>
  );
}

/** Every command that has a key, by group. */
export function ShortcutList() {
  useRegistryVersion();
  const withKeys = listCommands().filter((c) => c.keys);
  const groups = GROUPS.map((g) => ({ g, cmds: withKeys.filter((c) => c.group === g) })).filter((x) => x.cmds.length);
  return (
    <div className={s.sheet}>
      {groups.map(({ g, cmds }) => (
        <section key={g} aria-label={g}>
          <h3 className={s.sheetHead}>{g}</h3>
          <dl className={s.sheetList}>
            {cmds.map((c) => (
              <div key={c.id} className={s.sheetRow}>
                <dt>{c.title}</dt>
                <dd>
                  <KeyCaps keys={c.keys as string} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <section aria-label="Everywhere">
        <h3 className={s.sheetHead}>Everywhere</h3>
        <dl className={s.sheetList}>
          <div className={s.sheetRow}>
            <dt>Close the top-most dialog, menu or panel</dt>
            <dd>
              <KeyCaps keys="escape" />
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

export function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" size="md">
      <ShortcutList />
    </Dialog>
  );
}
