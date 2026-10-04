// The UI half of generating a file: the Share policy's confirm dialog (privacyShare.ts
// pvConfirmInclude) and the toasts. `useGenerateHooks()` returns the hooks the
// generators take and the dialog element to render once.

import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../../ui/Button';
import { Dialog } from '../../../ui/Dialog';
import { toast } from '../../../ui/Toast';
import type { ShareNote } from '../api';
import type { GenerateHooks } from './generate';

export function useGenerateHooks(): { hooks: GenerateHooks; dialog: React.ReactNode } {
  const [note, setNote] = useState<ShareNote | null>(null);
  const resolver = useRef<((yes: boolean) => void) | null>(null);
  const answer = useCallback((yes: boolean) => {
    resolver.current?.(yes);
    resolver.current = null;
    setNote(null);
  }, []);
  const hooks = useMemo<GenerateHooks>(
    () => ({
      confirmInclude: (n) =>
        new Promise<boolean>((resolve) => {
          resolver.current = resolve;
          setNote(n);
        }),
      say: (message) => void toast(message),
    }),
    [],
  );
  const dialog = (
    <Dialog
      open={note !== null}
      onOpenChange={(o) => !o && answer(false)}
      size="sm"
      title="Include sensitive columns?"
      description={note?.line}
      footer={
        <>
          <Button variant="ghost" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => answer(true)}>
            Include and build
          </Button>
        </>
      }
    >
      <p>
        This project’s share policy includes sensitive columns in reports as they are. The file leaves Ordinate once it is downloaded.{' '}
        <Link to="/settings">Change the policy</Link>
      </p>
    </Dialog>
  );
  return { hooks, dialog };
}
