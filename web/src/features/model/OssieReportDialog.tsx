// The result of Export ▾ Ossie (semantic layer part 7, g1): the file has already started downloading; this says what
// the Ossie document could not hold, kind by kind with the server's reason, and which datasets name no source table.

import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import { EmptyState } from '../../ui/States';
import { ossieGroups, type OssieReport } from './api';
import s from './OssieReportDialog.module.css';

export function OssieReportDialog({ version, report, onClose }: { version: string; report: OssieReport; onClose: () => void }) {
  const groups = ossieGroups(report);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Exported for Ossie"
      description={`The file follows Ossie ${version}, a draft of the spec. Nothing is imported back.`}
      size="lg"
      footer={
        <DialogClose asChild>
          <Button variant="primary">Close</Button>
        </DialogClose>
      }
    >
      {groups.length === 0 ? (
        <EmptyState icon="check" title="Everything mapped." heading={3}>
          Every definition in this project is in the file.
        </EmptyState>
      ) : (
        <>
          <h3 className={s.lead}>Not in the file as Ossie has no place for it</h3>
          <div className={s.rows}>
            {groups.map((g) => (
              <section key={g.kind} className={s.row} data-kind={g.kind} aria-label={g.title}>
                <span className={s.mark} aria-hidden="true">
                  <Icon name="minus" size={12} />
                </span>
                <div className={s.body}>
                  <h4 className={s.title}>{g.title}</h4>
                  <p className={s.names}>{g.names.join(', ')}</p>
                  <p className={s.note}>{g.reason}</p>
                </div>
              </section>
            ))}
          </div>
          <p className={s.foot}>What Ossie cannot hold also sits in the file under the ordinate extension, so nothing is lost.</p>
        </>
      )}
      {report.noSource.length > 0 && (
        <p className={s.foot}>
          <Icon name="database" size={12} /> No source table is named for {report.noSource.join(', ')}: the file gives each one its own name as its source.
        </p>
      )}
    </Dialog>
  );
}
