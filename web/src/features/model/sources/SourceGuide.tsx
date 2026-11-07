// A source table's Guide: the technical markdown note an editor wrote, rendered by part 1's renderer,
// with who edited it last. A typed {{name}} stays as typed: nothing here resolves a metric.

import { Button } from '../../../ui/Button';
import { EmptyState } from '../../../ui/States';
import { MarkdownView } from '../../dashboards/Markdown';
import { ago } from '../../data/format';
import type { SourceDoc } from './api';
import m from '../Model.module.css';
import x from './Sources.module.css';

const keepToken = (n: string) => ({ text: `{{${n}}}`, missing: true });

export function SourceGuide({ doc, onWrite }: { doc: SourceDoc; onWrite: () => void }) {
  if (!doc.guide) {
    return (
      <EmptyState
        icon="file-text"
        heading={3}
        title="No guide yet"
        actions={
          <Button variant="primary" icon="pencil" onClick={onWrite}>
            Write guide
          </Button>
        }
      >
        Write this table’s guide: partitions, filters to always use, load times. Datasets built from it show it in their own Guide.
      </EmptyState>
    );
  }
  return (
    <div className={m.guide}>
      <div className={x.guideBody}>
        <MarkdownView text={doc.guide} token={keepToken} />
      </div>
      {doc.updatedAt && <p className={m.stamp}>{`Last edited by ${doc.updatedBy || 'someone'}, ${ago(doc.updatedAt)}`}</p>}
    </div>
  );
}
