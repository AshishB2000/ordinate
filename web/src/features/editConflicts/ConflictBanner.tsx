// The banner a whole-document editor shows when another tab or person saved
// the record first (docs/edit-conflicts/00-design.md): the editor's autosave
// has stopped (useEditGuard), and the only ways on are Reload — drop my unsaved
// change — or Save mine as a copy — a new record from my document, opened. It
// has no close button: dismissed, the editor would sit there refusing saves.

import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import s from './ConflictBanner.module.css';

/** What the banner calls the record. */
export type ConflictNoun = 'dashboard' | 'visual' | 'metric' | 'metric tree' | 'report' | 'story' | 'scorecard' | 'scenario';

export function ConflictBanner({
  noun,
  onReload,
  onCopy,
  compact,
}: {
  noun: ConflictNoun;
  /** Drop the unsaved change and open the record as it is now. */
  onReload: () => void;
  /** Create a new record from this editor's document and open it; throws its reason on a refusal. */
  onCopy: () => Promise<void>;
  /** Inside a dialog: tighter, the actions under the text. */
  compact?: boolean;
}) {
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState('');
  // It appears mid-edit — in a long dialog, scrolled down to the field being typed in: bring it into view.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const copy = async () => {
    setCopying(true);
    setError('');
    try {
      await onCopy();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'The copy could not be saved.');
    } finally {
      setCopying(false);
    }
  };
  return (
    <div ref={ref} className={compact ? `${s.banner} ${s.compact}` : s.banner} role="alert" data-edit-conflict="">
      <span className={s.icon} aria-hidden="true">
        <Icon name="alert" size={16} />
      </span>
      <div className={s.text}>
        <p className={s.title}>This {noun} was changed in another tab or by someone else.</p>
        <p className={s.body}>
          Your changes since then are not saved, and saving is paused. Reload to see the latest version, or save yours as a separate copy.
        </p>
        {error && <p className={s.error}>{error}</p>}
      </div>
      <div className={s.actions}>
        <Button size="sm" icon="refresh" onClick={onReload} disabled={copying}>
          Reload
        </Button>
        <Button size="sm" variant="primary" icon="copy" onClick={() => void copy()} loading={copying}>
          {copying ? 'Saving a copy…' : 'Save mine as a copy'}
        </Button>
      </div>
    </div>
  );
}
