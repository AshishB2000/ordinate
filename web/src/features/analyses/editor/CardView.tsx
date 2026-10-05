// One card on the sheet: its head (title, Properties, ⋯) and its body by kind
// (legacy dashCardChrome.ts + dashGrid.ts bodies + cardKinds.ts + layoutKinds.ts).
// A visual draws through the shared engines; a KPI through the server's
// figure; text, dividers and groups are the record's own words.

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { IconButton, buttonClass } from '../../../ui/Button';
import { Menu, type MenuEntry } from '../../../ui/Menu';
import { Icon } from '../../../ui/icons/Icon';
import type { Card } from '../api';
import { vizLabel } from '../VisualTile';
import { builderFor } from './AddVisual';
import { useEditor } from './context';
import { activeTab, childrenOf } from './geometry';
import { substitute } from './filters';
import { ImageBody, NavBody, StatsBody, statsTitle, type ImageSpec, type StatsSpec } from './KindCards';
import { MetricBody, metricLabel } from './MetricCard';
import { toggleCrossFilter } from './filters';
import s from './Cards.module.css';
import { TextBody } from '../../dashboards/Markdown';
import { SummaryBody } from '../../dashboards/SummaryBody';
import { CommentButton } from '../../dashboards/CommentsPanel';
import { VisualCard, WatchedBell } from '../../dashboards/CardRuntime';

const KIND_TITLE: Record<string, string> = {
  nav: 'Navigation',
  image: 'Image',
  divider: 'Divider',
  stats: 'Statistics',
  summary: 'Summary',
  text: 'Text',
};

/** The title a card's head shows (dashCardTitle / cardKindTitle). */
export function cardTitle(card: Card, ed: ReturnType<typeof useEditor>): string {
  if (card.type === 'visual') {
    const v = card.visualId ? ed.visuals.get(card.visualId) : undefined;
    return v ? substitute(v.name || vizLabel(v.chartType), ed.params) : 'Visual';
  }
  if (card.type === 'metric' && card.metric) return metricLabel(card.metric);
  if (card.type === 'text') return card.heading ? substitute(card.heading, ed.params) : 'Text';
  if (card.type === 'container') return card.container?.title || 'Container';
  if (card.type === 'tabs') return 'Tabs';
  if (card.type === 'stats') return statsTitle(card.stats as StatsSpec | undefined);
  if (card.type === 'image') return (card.image as ImageSpec | undefined)?.alt || 'Image';
  return KIND_TITLE[card.type] ?? card.type;
}

function Missing({ children }: { children: ReactNode }) {
  return (
    <div className={s.placeholder}>
      <Icon name="alert" size={16} />
      <span>{children}</span>
    </div>
  );
}

function Body({ card, asTable }: { card: Card; asTable: boolean }) {
  const ed = useEditor();
  if (card.type === 'visual') {
    const def = card.visualId ? ed.visuals.get(card.visualId) : undefined;
    // A dangling visualId degrades to a placeholder, never a crash (00-model.md §6.4).
    if (!def) return <Missing>The visual this card showed was deleted.</Missing>;
    // Click-to-filter (overrides.crossFilter, off by default): the clicked value becomes a DASHBOARD filter.
    const column = def.overrides?.crossFilter === true ? def.encoding.category : '';
    const onMark = column ? (v: string | number) => ed.edit('Cross-filter', (d) => void (d.filters = toggleCrossFilter(d.filters, column, v))) : undefined;
    // A tile's own actions (T2.9) outrank cross-filter, as on the desktop; a narrowing reads here too.
    return <VisualCard ed={ed} card={card} def={def} asTable={asTable} onMark={onMark} />;
  }
  if (card.type === 'stats') return <StatsBody card={card} />;
  if (card.type === 'image') return <ImageBody card={card} />;
  if (card.type === 'nav') return <NavBody card={card} />;
  if (card.type === 'metric') return card.metric ? <MetricBody card={card} /> : <Missing>No metric</Missing>;
  // Markdown with {{tokens}} — a parameter, else a saved metric's figure (textCard.ts, T2.9).
  if (card.type === 'text') return <TextBody projectId={ed.projectId} text={card.text ?? ''} params={ed.params} filters={ed.filters} />;
  if (card.type === 'summary') return <SummaryBody ed={ed} cardId={card.id} />;
  if (card.type === 'divider') return card.divider?.style === 'spacer' ? null : <hr className={s.divider} />;
  if (card.type === 'container' || card.type === 'tabs') {
    const tab = card.type === 'tabs' ? activeTab(card, ed.groupTab.get(card.id)) : undefined;
    const kids = childrenOf(ed.cards, card.id).filter((c) => !tab || c.tabId === tab);
    if (kids.length) return null;
    return <p className={s.groupEmpty}>{tab ? 'Drag cards into this tab.' : 'Drag cards in here — they move with it.'}</p>;
  }
  // A card kind this build does not draw: the record keeps it; the sheet says so.
  return (
    <div className={s.placeholder}>
      <Icon name="layout-dashboard" size={16} />
      <span>{KIND_TITLE[card.type] ?? card.type} card — not shown here.</span>
    </div>
  );
}

/** The head's title, or a tabs card's tab strip (layoutKinds.ts renderTabsCard). */
function Title({ card, title }: { card: Card; title: string }) {
  const ed = useEditor();
  if (card.type !== 'tabs') return <span className={s.title}>{title}</span>;
  const items = card.tabs?.items ?? [];
  const active = activeTab(card, ed.groupTab.get(card.id));
  return (
    <div className={s.tabs} role="tablist" aria-label={`${title} tabs`}>
      {items.map((t, i) => (
        <button
          key={t.id}
          id={`tab-${card.id}-${t.id}`}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          aria-controls={`panel-${card.id}`}
          tabIndex={t.id === active ? 0 : -1}
          className={t.id === active ? `${s.tab} ${s.tabOn}` : s.tab}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            ed.setGroupTab(card.id, t.id);
          }}
          onKeyDown={(e) => {
            // Roving tabindex (layoutKinds.ts renderTabsCard): arrows wrap, Home / End jump; focus follows the tab.
            const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
            if (next === null) return;
            e.preventDefault();
            e.stopPropagation();
            const to = items[(next + items.length) % items.length];
            ed.setGroupTab(card.id, to.id);
            const strip = e.currentTarget.parentElement;
            requestAnimationFrame(() => strip?.querySelector<HTMLElement>(`[id="tab-${card.id}-${to.id}"]`)?.focus());
          }}
        >
          {t.name}
        </button>
      ))}
    </div>
  );
}

export function CardView({
  card,
  menu,
  onHeadPointerDown,
  handles,
  onKeyDown,
  className,
  style,
  onHide,
  asTable = false,
}: {
  card: Card;
  menu: MenuEntry[];
  onHeadPointerDown: (e: React.PointerEvent) => void;
  handles: ReactNode;
  onKeyDown: (e: React.KeyboardEvent) => void;
  className: string;
  style: React.CSSProperties;
  /** A small size: the one-click "Hide on <size>" in the head (layoutEdit.ts ly-hide-btn). */
  onHide?: { label: string; run: () => void };
  asTable?: boolean;
}) {
  const ed = useEditor();
  const title = cardTitle(card, ed);
  const folded = card.type === 'container' && !!card.container?.collapsible && ed.folded.has(card.id);
  const visualId = card.type === 'visual' ? card.visualId : undefined;
  return (
    <div
      // A one-row navigation or divider card has no room for a head: it floats in the corner (authoring.css).
      className={card.type === 'nav' || card.type === 'divider' ? `${className} ${s.slim}` : className}
      style={style}
      data-card-id={card.id}
      data-kind={card.type}
      tabIndex={0}
      role="group"
      aria-label={`${title} card`}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [role="tab"]')) return;
        if (e.shiftKey) {
          // ⇧-click adds a card to (or takes it out of) the multi-selection (gridArrange.ts).
          const next = new Set(ed.multi);
          if (!next.size && ed.selected && ed.selected !== card.id) next.add(ed.selected);
          if (next.has(card.id)) next.delete(card.id);
          else next.add(card.id);
          ed.setMulti(next);
          return;
        }
        if (!ed.multi.has(card.id)) ed.setMulti(new Set());
        ed.select(card.id);
      }}
    >
      <div className={s.head} onPointerDown={onHeadPointerDown}>
        {card.type === 'container' && card.container?.collapsible && (
          <IconButton
            icon={folded ? 'chevron-right' : 'chevron-down'}
            size="sm"
            label={`${folded ? 'Expand' : 'Collapse'} ${title}`}
            aria-expanded={!folded}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => ed.toggleFold(card.id)}
          />
        )}
        <Title card={card} title={title} />
        {/* Present: a reading view, no card controls (dashShare.ts). */}
        {!ed.view.presenting && (
        <span className={s.ctrls} onPointerDown={(e) => e.stopPropagation()}>
          {card.type === 'metric' && <WatchedBell ed={ed} card={card} />}
          {card.type !== 'control' && card.type !== 'divider' && <CommentButton ed={ed} card={card} />}
          {onHide && <IconButton icon="eye-off" size="sm" label={`${onHide.label}: ${title}`} onClick={onHide.run} />}
          {visualId && (
            <Link className={buttonClass('ghost', 'sm', s.edit)} to={builderFor(ed.projectId, visualId)} title="Edit this visual in the Visuals builder">
              <Icon name="pencil" size={12} />
              <span>Edit</span>
            </Link>
          )}
          <IconButton
            icon="sliders"
            size="sm"
            label="Card properties"
            onClick={() => {
              ed.select(card.id);
              ed.setPane('props');
            }}
          />
          <Menu label={`${title} card actions`} align="end" trigger={<IconButton icon="more-horizontal" size="sm" label={`${title} card actions`} />} items={menu} />
        </span>
        )}
      </div>
      {!folded && (
        <div className={s.body} id={card.type === 'tabs' ? `panel-${card.id}` : undefined} role={card.type === 'tabs' ? 'tabpanel' : undefined}
          aria-labelledby={card.type === 'tabs' ? `tab-${card.id}-${activeTab(card, ed.groupTab.get(card.id))}` : undefined}>
          <Body card={card} asTable={asTable} />
        </div>
      )}
      {handles}
    </div>
  );
}
