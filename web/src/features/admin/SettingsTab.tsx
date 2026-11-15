// Admin → Settings: the org's own switches. Public links (publishing a
// dashboard to a link anyone can open), an upload cap the server enforces
// under its own MAX_UPLOAD_MB, and how long an unused Assistant conversation is
// kept (the server's sweep deletes older ones). Which AI models members may use
// is Admin → AI.

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
  const [keepDays, setKeepDays] = useState(saved.assistantRetentionDays === null ? '' : String(saved.assistantRetentionDays));
  const save = useWrite('admin:saveSettings', ['admin:settings'], (r) => r.ok && toast('Settings saved.', { kind: 'success' }));
  const capNum = cap.trim() === '' ? null : Number(cap);
  const capError =
    capNum !== null && (!Number.isInteger(capNum) || capNum < 1)
      ? 'A whole number of megabytes, 1 or more.'
      : capNum !== null && capNum > saved.maxUploadMb
        ? `At most ${saved.maxUploadMb} MB, the server's limit.`
        : undefined;
  const daysNum = keepDays.trim() === '' ? null : Number(keepDays);
  const daysError = daysNum !== null && (!Number.isInteger(daysNum) || daysNum < 1 || daysNum > 3650) ? 'A whole number of days, from 1 to 3650.' : undefined;
  const dirty = publicLinks !== saved.publicLinks || capNum !== saved.uploadCapMb || daysNum !== saved.assistantRetentionDays;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (capError || daysError) return;
    save.mutate({ publicLinks, uploadCapMb: capNum, assistantRetentionDays: daysNum });
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
      <div className={s.group}>
        <h3 className={s.groupTitle}>Assistant</h3>
        <div className={s.capField}>
          <Input
            label="Delete conversations unused for (days)"
            inputMode="numeric"
            placeholder="Keep them all"
            value={keepDays}
            onChange={(e) => setKeepDays(e.target.value)}
            error={daysError}
            hint="Empty: every conversation is kept."
          />
        </div>
        <p className={s.lead}>
          A conversation nobody has asked in for this many days is deleted with its answers, for every member. Saved visuals and dashboards stay.
        </p>
      </div>
      <div>
        <Button variant="primary" type="submit" icon="check" loading={save.isPending} disabled={!dirty || !!capError || !!daysError}>
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
