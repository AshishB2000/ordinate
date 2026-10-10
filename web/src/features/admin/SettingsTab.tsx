// Admin → Settings: the org's own switches. Public links (publishing a
// dashboard to a link anyone can open) and an upload cap the server enforces
// under its own MAX_UPLOAD_MB. Which AI models members may use is Admin → AI.

import { useState, type FormEvent } from 'react';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Choice';
import { Input } from '../../ui/Field';
import { SkeletonBlock } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useOrgSettings, useWrite, type OrgSettings } from './api';
import s from './Admin.module.css';

function SettingsForm({ saved }: { saved: OrgSettings }) {
  const [publicLinks, setPublicLinks] = useState(saved.publicLinks);
  const [cap, setCap] = useState(saved.uploadCapMb === null ? '' : String(saved.uploadCapMb));
  const save = useWrite('admin:saveSettings', ['admin:settings'], (r) => r.ok && toast('Settings saved.', { kind: 'success' }));
  const capNum = cap.trim() === '' ? null : Number(cap);
  const capError =
    capNum !== null && (!Number.isInteger(capNum) || capNum < 1)
      ? 'A whole number of megabytes, 1 or more.'
      : capNum !== null && capNum > saved.maxUploadMb
        ? `At most ${saved.maxUploadMb} MB, the server's limit.`
        : undefined;
  const dirty = publicLinks !== saved.publicLinks || capNum !== saved.uploadCapMb;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (capError) return;
    save.mutate({ publicLinks, uploadCapMb: capNum });
  };
  return (
    <form className={s.form} onSubmit={submit} aria-label="Organization settings">
      <div className={s.group}>
        <h3 className={s.groupTitle}>Sharing</h3>
        <Switch
          label="Allow public links"
          hint="Members may publish a dashboard to a link that opens without signing in. Off: only signed-in members see anything."
          checked={publicLinks}
          onCheckedChange={setPublicLinks}
        />
      </div>
      <div className={s.group}>
        <h3 className={s.groupTitle}>Uploads</h3>
        <div className={s.capField}>
          <Input
          label="Largest upload (MB)"
          inputMode="numeric"
          placeholder={String(saved.maxUploadMb)}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          error={capError}
            hint={`Empty: the server's limit, ${saved.maxUploadMb} MB.`}
          />
        </div>
        <p className={s.lead}>A lower number caps uploads for this organization only; the server's limit always applies.</p>
      </div>
      <div>
        <Button variant="primary" type="submit" icon="check" loading={save.isPending} disabled={!dirty || !!capError}>
          Save settings
        </Button>
      </div>
    </form>
  );
}

export function SettingsTab() {
  const settings = useOrgSettings();
  if (settings.isPending) return <SkeletonBlock label="Loading settings" />;
  if (settings.isError) {
    return <ErrorState heading={3} title="Settings could not be loaded" message={settings.error.message} onRetry={() => void settings.refetch()} />;
  }
  return (
    <section className={s.section} aria-label="Settings">
      <SettingsForm key={JSON.stringify(settings.data)} saved={settings.data} />
    </section>
  );
}
