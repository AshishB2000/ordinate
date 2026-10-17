// One block of a story (storyBlocks.ts): how it looks and how it is edited in
// place. Text is Markdown drawn as a document — click (or Enter) to edit the
// source; `/` on an empty line opens the block picker. A chart and its metrics
// are LIVE figures the server computed (`story:figures`); a caption left empty
// shows the app's own sentence as its placeholder, so clearing it brings the
// app's back. A story stores ids, never numbers. `readOnly` (a viewer): the
// same document with nothing to click into — no gutter, no editor, captions as
// figcaptions, pinned filters without a way to change them.

import { useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { IconButton } from '../../../ui/Button';
import { Menu } from '../../../ui/Menu';
import { Skeleton, SkeletonBlock } from '../../../ui/Skeleton';
import { Icon, type IconName } from '../../../ui/icons/Icon';
import { DrawnVisual } from '../../analyses/VisualTile';
import type { CalloutTone, MetricFigure, Step, StoryBlock as Block, VisualFigure } from '../api';
import { pickMenu, useSlashPicker, type PickKind } from './BlockPicker';
import { Markdown } from './Markdown';
import s from './Story.module.css';

const TONE_ICON: Record<CalloutTone, IconName> = { info: 'info', success: 'check', warning: 'alert', danger: 'alert' };
const TONES: CalloutTone[] = ['info', 'success', 'warning', 'danger'];

export interface BlockProps {
  projectId: string;
  block: Block;
  index: number;
  count: number;
  editing: boolean;
  /** A viewer's page: drawn, never edited. */
  readOnly?: boolean;
  figure: VisualFigure | MetricFigure | undefined;
  figuresPending: boolean;
  onChange: (block: Block, label: string, coalesce?: boolean) => void;
  onEdit: (id: string) => void;
  /** This block's editor closed (blur / Escape) — clears the edit only if it is still this block's. */
  onEndEdit: () => void;
  onAddAfter: (kind: PickKind) => void;
  onPickInto: (kind: PickKind) => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onBackspaceEmpty: () => void;
  onPin: () => void;
  onDragHandle: (armed: boolean) => void;
}

function grow(ta: HTMLTextAreaElement | null): void {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function TextEditor({ block, props }: { block: Extract<Block, { kind: 'text' | 'callout' }>; props: BlockProps }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    grow(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);
  const slashing = block.kind === 'text' && /^\/\S*$/.test(block.text);
  const picker = useSlashPicker(slashing ? block.text : null, props.onPickInto);
  return (
    <div className={s.editorWrap}>
      <textarea
        ref={ref}
        className={s.textInput}
        rows={1}
        value={block.text}
        placeholder={block.kind === 'callout' ? 'Callout text' : 'Type, or “/” for blocks'}
        aria-label={block.kind === 'callout' ? 'Callout text' : 'Text'}
        aria-controls={slashing ? 'st-slash' : undefined}
        aria-activedescendant={slashing ? picker.activeId : undefined}
        maxLength={20_000}
        onChange={(e) => {
          grow(e.target);
          props.onChange({ ...block, text: e.target.value }, 'Edit text', true);
        }}
        onKeyDown={(e) => {
          if (picker.keys(e)) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            props.onEndEdit();
          } else if (e.key === 'Backspace' && block.kind === 'text' && block.text === '') {
            e.preventDefault();
            props.onBackspaceEmpty();
          }
        }}
        onBlur={() => !slashing && props.onEndEdit()}
      />
      {picker.list}
    </div>
  );
}

function TextView({ block, props }: { block: Extract<Block, { kind: 'text' | 'callout' }>; props: BlockProps }) {
  return (
    <div
      className={s.editable}
      role="button"
      tabIndex={0}
      aria-label="Edit text"
      // Mouse-DOWN, with the default prevented: the editor open elsewhere closes by re-render, not by a
      // blur whose re-layout would move this line out from under the pointer before the click lands.
      onMouseDown={(e) => {
        e.preventDefault();
        props.onEdit(block.id);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          props.onEdit(block.id);
        }
      }}
    >
      {block.text.trim() ? <Markdown src={block.text} /> : <div className={s.placeholder}>{block.kind === 'callout' ? 'Write the callout' : 'Type “/” for charts, metrics and more'}</div>}
    </div>
  );
}

function Caption({ block, appCaption, props }: { block: Extract<Block, { kind: 'visual' | 'metric' | 'image' }>; appCaption: string; props: BlockProps }) {
  if (props.readOnly) {
    const text = block.caption || appCaption;
    return text ? <figcaption className={s.figcaption}>{text}</figcaption> : null;
  }
  return (
    <textarea
      className={s.caption}
      rows={1}
      aria-label="Caption"
      maxLength={400}
      value={block.caption ?? ''}
      placeholder={appCaption || 'Add a caption'}
      onChange={(e) => {
        const next = { ...block };
        if (e.target.value.trim()) next.caption = e.target.value;
        else delete next.caption;
        props.onChange(next, 'Edit caption', true);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), (e.target as HTMLTextAreaElement).blur())}
    />
  );
}

function pinText(f: Step): string {
  const v = Array.isArray(f.values) ? f.values.join(', ') : f.value === undefined ? '' : String(f.value);
  return `${String(f.column)} ${String(f.op)}${v ? ' ' + v : ''}`;
}

function Body({ props }: { props: BlockProps }) {
  const { block, figure, figuresPending, projectId } = props;
  switch (block.kind) {
    case 'text':
      if (props.readOnly) return block.text.trim() ? <Markdown src={block.text} /> : null;
      return props.editing ? <TextEditor block={block} props={props} /> : <TextView block={block} props={props} />;
    case 'callout':
      return (
        <div className={`${s.callout} ${s[`tone_${block.tone}`]}`}>
          {props.readOnly ? (
            <span className={s.calloutIcon} aria-hidden="true">
              <Icon name={TONE_ICON[block.tone]} size={16} />
            </span>
          ) : (
            <IconButton
              icon={TONE_ICON[block.tone]}
              label="Change the callout style"
              size="sm"
              onClick={() => props.onChange({ ...block, tone: TONES[(TONES.indexOf(block.tone) + 1) % TONES.length] }, 'Callout style')}
            />
          )}
          <div className={s.calloutBody}>
            {props.readOnly ? <Markdown src={block.text} /> : props.editing ? <TextEditor block={block} props={props} /> : <TextView block={block} props={props} />}
          </div>
        </div>
      );
    case 'divider':
      return <hr className={s.hr} />;
    case 'image':
      return (
        <figure className={s.figure}>
          <img className={s.img} src={block.src} alt={block.alt} />
          <Caption block={block} appCaption="" props={props} />
        </figure>
      );
    case 'visual': {
      const fig = figure as VisualFigure | undefined;
      if (!fig && figuresPending) return <div className={s.figure}><Skeleton className={s.figTitleSk} /><div className={s.chart}><SkeletonBlock label="Loading chart" /></div></div>;
      if (!fig || 'missing' in fig) {
        return (
          <div className={`${s.figure} ${s.missing}`}>
            <Icon name="alert" /> This chart no longer exists.
          </div>
        );
      }
      return (
        <figure className={s.figure}>
          <div className={s.figHead}>
            <div className={s.figTitle}>{fig.title || 'Chart'}</div>
            <div className={s.pins}>
              {block.filters.map((f, i) => (
                <span key={i} className={s.pin}>
                  {pinText(f)}
                  {!props.readOnly && (
                    <button type="button" className={s.pinX} aria-label={`Remove the filter ${pinText(f)}`} onClick={() => props.onChange({ ...block, filters: block.filters.filter((_, j) => j !== i) }, 'Remove filter')}>
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </span>
              ))}
              {!props.readOnly && (
                <button type="button" className={s.pinAdd} onClick={props.onPin}>
                  <Icon name="filter" size={12} /> Pin a filter
                </button>
              )}
            </div>
          </div>
          <div className={s.chart}>
            {fig.chart ? <DrawnVisual type={fig.chart.type} data={fig.chart.data} overrides={fig.chart.overrides} label={fig.title || 'Chart'} projectId={projectId} /> : <p className={s.figNote}>{fig.note}</p>}
          </div>
          <Caption block={block} appCaption={fig.caption} props={props} />
        </figure>
      );
    }
    case 'metric':
    case 'metrics_row': {
      const fig = figure as MetricFigure | undefined;
      const n = block.kind === 'metric' ? 1 : block.metricIds.length;
      // A viewer's caption is a figcaption: its block is the figure.
      const Wrap = props.readOnly ? 'figure' : 'div';
      return (
        <Wrap className={props.readOnly ? s.metricFigure : undefined}>
          <div className={block.kind === 'metric' ? `${s.metrics} ${s.metricsOne}` : s.metrics}>
            {fig
              ? fig.figures.map((f, i) => (
                  <div key={i} className={s.metric}>
                    <div className={s.metricValue}>{f.display}</div>
                    <div className={s.metricName}>{f.name}</div>
                  </div>
                ))
              : Array.from({ length: n }, (_, i) => (
                  <div key={i} className={s.metric} aria-busy="true">
                    <Skeleton className={s.metricSk} />
                  </div>
                ))}
          </div>
          {block.kind === 'metric' && <Caption block={block} appCaption={fig?.caption || ''} props={props} />}
        </Wrap>
      );
    }
  }
}

export function StoryBlockRow(props: BlockProps) {
  const { block, index, count } = props;
  const navigate = useNavigate();
  if (props.readOnly) {
    return (
      <div className={`${s.block} ${s[`kind_${block.kind}`] || ''}`} id={`st-b-${block.id}`} data-block-id={block.id} data-kind={block.kind}>
        {/* The gutter's column, empty: the document lines up with an editor's. */}
        <div aria-hidden="true" />
        <div className={s.blockBody}>
          <Body props={props} />
        </div>
      </div>
    );
  }
  return (
    <div className={`${s.block} ${s[`kind_${block.kind}`] || ''}`} id={`st-b-${block.id}`} data-block-id={block.id} data-kind={block.kind}>
      <div className={s.gutter}>
        <Menu label="Add a block below" trigger={<IconButton icon="plus" label="Add a block below" size="sm" />} items={pickMenu(props.onAddAfter)} />
        <span onPointerDown={() => props.onDragHandle(true)} onPointerUp={() => props.onDragHandle(false)}>
          <Menu
            label="Block options"
            trigger={<IconButton icon="grip-vertical" label="Drag to move, click for options" size="sm" />}
            items={[
              { label: 'Move up', icon: 'arrow-up', disabled: index === 0, onSelect: () => props.onMove(index - 1) },
              { label: 'Move down', icon: 'arrow-down', disabled: index >= count - 1, onSelect: () => props.onMove(index + 1) },
              { label: 'Duplicate', icon: 'copy', onSelect: props.onDuplicate },
              ...(block.kind === 'visual' ? [{ label: 'Open visual', icon: 'chart-bar' as const, onSelect: () => void navigate(`/visuals/${props.projectId}/${block.visualId}`) }] : []),
              { kind: 'separator' },
              { label: 'Delete', icon: 'trash', danger: true, onSelect: props.onRemove },
            ]}
          />
        </span>
      </div>
      <div className={s.blockBody}>
        <Body props={props} />
      </div>
    </div>
  );
}
