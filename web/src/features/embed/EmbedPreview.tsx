// "Preview embed": the server signs a ten-minute preview token
// (`embed:preview`, served only to an iframe of this app) and the real
// /embed/… page renders in a browser-window frame.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { useEmbedPreview, type Hide } from './api';
import s from './Embed.module.css';

export interface PreviewTarget {
  projectId: string;
  siteId: string;
  dashboardId: string;
  params: Record<string, (string | number)[]>;
  theme?: 'light' | 'dark';
  hide: Hide[];
}

const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

export function EmbedPreview({ target, host }: { target: PreviewTarget | null; host: string }) {
  const preview = useEmbedPreview();
  const [shown, setShown] = useState<{ url: string; expiresAt: string; key: string } | null>(null);
  const [error, setError] = useState('');
  const key = JSON.stringify(target);
  const stale = shown !== null && shown.key !== key;
  const run = () => {
    if (!target) return;
    setError('');
    preview.mutate(
      { ...target, ...(Object.keys(target.params).length ? {} : { params: undefined }), ...(target.hide.length ? {} : { hide: undefined }) },
      {
        onSuccess: (r) => (r.ok ? setShown({ url: r.url, expiresAt: r.expiresAt, key }) : setError(r.error)),
        onError: (e) => setError(e.message || 'The preview could not be signed.'),
      },
    );
  };
  return (
    <div className={s.stack}>
      <div className={s.formActions}>
        <Button variant={shown && !stale ? 'secondary' : 'primary'} icon={shown ? 'refresh' : 'eye'} loading={preview.isPending} disabled={!target} onClick={run}>
          {shown ? (stale ? 'Preview these settings' : 'Sign a new preview') : 'Preview embed'}
        </Button>
        {shown && !stale && <span className={s.previewMeta}>Signed by the server · works until {time.format(new Date(shown.expiresAt))}, inside Ordinate only</span>}
        {stale && <span className={s.previewMeta}>The settings changed since this preview.</span>}
      </div>
      <div className={s.browser}>
        <div className={s.chrome} aria-hidden="true">
          <span className={s.dots}>
            <span />
            <span />
            <span />
          </span>
          <span className={s.address}>{host}</span>
        </div>
        {shown ? (
          <iframe className={s.frame} title="Embedded dashboard preview" src={shown.url} key={shown.url} />
        ) : (
          <div className={s.framePlaceholder}>
            {error ? (
              <p role="alert">
                <Icon name="alert" size={16} /> {error}
              </p>
            ) : (
              <p>{target ? 'Preview shows the embed exactly as a host page frames it — locks, theme and all.' : 'Pick a published dashboard to preview.'}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
