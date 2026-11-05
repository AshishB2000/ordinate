// The status of a metric, term or dataset: a word and an icon, never colour alone.

import { Badge } from '../../../ui/Badge';
import { statusTitle, type StatusView } from './status';

export function StatusBadge({ status, compact }: { status?: StatusView; compact?: boolean }) {
  if (!status) return null;
  const { state } = status;
  const text =
    state === 'certified' ? 'Certified' : state === 'needs_review' ? 'Changed since certified' : status.replacedBy ? `Retired · use ${status.replacedBy.name}` : 'Retired';
  const tone = state === 'certified' ? 'ok' : state === 'needs_review' ? 'warn' : 'neutral';
  const icon = state === 'certified' ? 'circle-check' : state === 'needs_review' ? 'alert' : 'archive';
  return (
    <span title={statusTitle(status)} aria-label={compact ? text : undefined}>
      <Badge tone={tone} icon={icon}>
        {compact && state === 'needs_review' ? 'Changed' : compact && state === 'retired' ? 'Retired' : text}
      </Badge>
    </span>
  );
}
