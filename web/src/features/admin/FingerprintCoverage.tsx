// Admin → AI → the fingerprint card's status line (`ai:fingerprintStatus`): whether this database can hold
// fingerprints (pgvector, docs/server/upgrade.md) and, with a model saved, how far the background job has got. The
// counts are the server's; this only formats them.

import { Button } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { Skeleton } from '../../ui/Skeleton';
import { HELP_LINKS } from '../palette/appCommands';
import { useFingerprintStatus, type FingerprintStatus } from './api';
import s from './Admin.module.css';

const UPGRADE_DOC = `${HELP_LINKS.source}/blob/develop/docs/server/upgrade.md#pgvector-for-meaning-search-0029_pgvector`;

/** Why there is nowhere to keep fingerprints, in words. */
const WHY: Record<Exclude<FingerprintStatus['vectors'], 'ready'>, string> = {
  no_database: 'Meaning search needs Postgres: this server runs without DATABASE_URL.',
  no_extension: 'Meaning search needs the pgvector extension on your database.',
  not_created: 'Your Postgres offers pgvector, but it is not created in Ordinate’s database. An admin role runs CREATE EXTENSION vector; there.',
  no_table: 'pgvector is on your database, but Ordinate could not make its table: it needs pgvector 0.5 or later and CREATE on the schema.',
};

const n = (x: number): string => x.toLocaleString();

export function FingerprintCoverage({ model }: { model: string | null }) {
  const status = useFingerprintStatus(model);
  if (status.isPending) {
    return (
      <div className={s.fpStatus} role="status" aria-busy="true" aria-label="Loading meaning search status">
        <Skeleton className={s.fpSkel} />
      </div>
    );
  }
  if (status.isError) {
    return (
      <p className={s.warn} role="alert">
        <Icon name="alert" size={12} />
        The meaning search status did not load.
        <Button size="sm" variant="ghost" onClick={() => void status.refetch()}>
          Retry
        </Button>
      </p>
    );
  }
  const { vectors, items, fingerprinted } = status.data;
  if (vectors !== 'ready') {
    return (
      <p className={s.warn}>
        <Icon name="database" size={12} />
        <span>
          {WHY[vectors] ?? WHY.no_table} Until then, the Assistant finds items by their words.{' '}
          <a className={s.fpLink} href={UPGRADE_DOC} target="_blank" rel="noopener noreferrer">
            How to add pgvector
          </a>
        </span>
      </p>
    );
  }
  if (!model || items === null || fingerprinted === null) return null;
  if (items === 0) return <p className={s.fpStatus}>Nothing to fingerprint yet. Items are fingerprinted once a project’s search has them.</p>;
  const done = fingerprinted === items;
  return (
    <p className={done ? `${s.fpStatus} ${s.fpDone}` : s.fpStatus}>
      <Icon name={done ? 'circle-check' : 'loader'} size={12} />
      {done ? `All ${n(items)} items are fingerprinted.` : `Fingerprinted ${n(fingerprinted)} of ${n(items)} items. The rest are found by their words until the job reaches them.`}
    </p>
  );
}
