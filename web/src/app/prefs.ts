// The workspace's formats and accent — brand.ts, ported. Read once when the
// shell mounts (`prefs:get`): the formats go to the one formatter every chart,
// card and table writes figures with (src/app/format.ts, shared with the
// server), the accent becomes the --brand-* tokens theme.css reads on <html>.
// The logo is not loaded here: its consumers (present mode, report covers,
// exports) fetch it when they draw.

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as OrdFormat from '../../../src/app/format.ts';
import { rpc } from '../api/client';
import { applyBrandTokens } from '../charts/palette';

interface Prefs {
  formats?: unknown;
  branding?: { accent?: unknown };
}

export function useWorkspacePrefs(): void {
  const q = useQuery({
    queryKey: ['prefs:get'],
    queryFn: async () => (await rpc('prefs:get')) as Prefs | null,
    staleTime: Infinity,
  });
  const prefs = q.data;
  useEffect(() => {
    if (!prefs || typeof prefs !== 'object') return;
    if (prefs.formats) OrdFormat.setFormatPrefs(prefs.formats);
    const accent = prefs.branding?.accent;
    applyBrandTokens(document.documentElement, typeof accent === 'string' ? accent : '');
  }, [prefs]);
}
