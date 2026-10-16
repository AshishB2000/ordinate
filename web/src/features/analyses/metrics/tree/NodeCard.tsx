// One node of a metric tree: its figure, the period before, the change, a
// sparkline and — below the root — its contribution to its parent's change.
// Every string is the server's (metricTree:compute); the share bar is only
// drawn to the server's share, never computed here.

import { Icon } from '../../../../ui/icons/Icon';
import { Sparkline } from '../Sparkline';
import type { TreeNode } from './api';
import s from './MetricTree.module.css';

export type Tone = 'good' | 'bad' | 'neutral';

/** Is a move of this sign good news, by the metric's own direction? */
export function toneOf(direction: TreeNode['direction'], value: number | null | undefined): Tone {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0 || !direction) return 'neutral';
  return (value > 0) === (direction === 'up_good') ? 'good' : 'bad';
}

const TONE: Record<Tone, string> = { good: s.good, bad: s.bad, neutral: s.neutral };

/** What a screen reader hears for a node: the card's figures in one sentence. */
export function nodeLabel(n: TreeNode): string {
  const parts = [n.name, n.display];
  if (n.changeDisplay && n.changeDisplay !== '—') parts.push(`change ${n.changeDisplay}${n.pctDisplay ? ` (${n.pctDisplay})` : ''} from ${n.previousDisplay}`);
  if (n.contributionDisplay) parts.push(`contributes ${n.contributionDisplay}${n.shareDisplay ? `, ${n.shareDisplay} of the change` : ''}`);
  if (n.lead) parts.push('explains most of the change');
  return parts.join(', ');
}

export function NodeCard({
  node,
  parentDirection,
  root,
  open,
  onToggle,
}: {
  node: TreeNode;
  /** The parent's direction: a contribution is good or bad news for the PARENT. */
  parentDirection?: TreeNode['direction'];
  root?: boolean;
  open: boolean;
  onToggle?: () => void;
}) {
  const changeTone = toneOf(node.direction, node.change);
  const contribTone = toneOf(parentDirection, node.contribution);
  const share = typeof node.share === 'number' && Number.isFinite(node.share) ? Math.min(100, Math.abs(node.share)) : null;
  const cls = [s.card, root && s.rootCard, node.lead && s.leadCard, node.lead && TONE[root ? changeTone : contribTone], node.kind === 'segment' && s.segment].filter(Boolean).join(' ');

  if (node.kind === 'residual') {
    return (
      <div className={`${s.card} ${s.residual}`} data-card="">
        <div className={s.cardHead}>
          <Icon name="info" size={12} />
          <span className={s.name}>{node.name}</span>
        </div>
        <div className={s.contrib}>
          <span className={`${s.contribValue} ${TONE[contribTone]}`}>{node.contributionDisplay}</span>
          {node.shareDisplay && <span className={s.shareText}>{node.shareDisplay} of the change</span>}
        </div>
      </div>
    );
  }

  return (
    <div className={cls} data-card="">
      <div className={s.cardHead}>
        {node.kind === 'segment' && <span className={s.segDot} aria-hidden="true" />}
        <span className={s.name} title={node.name}>
          {node.name}
        </span>
        {onToggle && (
          <button
            type="button"
            tabIndex={-1}
            className={s.toggle}
            aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
          </button>
        )}
      </div>
      <div className={s.figureRow}>
        <span className={root ? `${s.value} ${s.rootValue}` : s.value}>{node.display}</span>
        {node.spark && (
          <span className={`${s.spark} ${TONE[changeTone]}`}>
            <Sparkline values={node.spark} label={`${node.name}, the last ${node.spark.length} months`} />
          </span>
        )}
      </div>
      <div className={s.changeRow}>
        {node.changeDisplay !== '—' ? (
          <span className={`${s.pill} ${TONE[changeTone]}`}>
            {node.changeDisplay}
            {node.pctDisplay && <span className={s.pillPct}>{node.pctDisplay}</span>}
          </span>
        ) : (
          <span className={s.pill}>No change to show</span>
        )}
        <span className={s.was}>was {node.previousDisplay}</span>
      </div>
      {node.contributionDisplay !== undefined && (
        <div className={s.contrib}>
          <div className={s.contribLine}>
            <span className={`${s.contribValue} ${TONE[contribTone]}`}>{node.contributionDisplay}</span>
            {node.shareDisplay && <span className={s.shareText}>{node.shareDisplay} of the change</span>}
          </div>
          {share !== null && (
            <span className={s.shareTrack} aria-hidden="true">
              <span className={`${s.shareBar} ${TONE[contribTone]}`} style={{ width: `${share}%` }} />
            </span>
          )}
          {node.mixDisplay && (
            <span className={s.mixRate}>
              mix {node.mixDisplay} · rate {node.rateDisplay}
            </span>
          )}
        </div>
      )}
      {node.note && (
        <p className={s.note}>
          <Icon name="info" size={12} />
          <span>{node.note}</span>
        </p>
      )}
      {node.breakdown && (
        <div className={s.breakdown}>
          <Icon name={node.breakdown.kind === 'split' ? 'layers' : 'function'} size={12} />
          <span>{node.breakdown.kind === 'split' ? node.breakdown.text : `= ${node.breakdown.text}`}</span>
        </div>
      )}
    </div>
  );
}
