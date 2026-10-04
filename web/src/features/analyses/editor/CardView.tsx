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
import { VisualTileBody, vizLabel } from '../VisualTile';
import { builderFor } from './AddVisual';
import { useEditor } from './context';
import { activeTab, childrenOf } from './geometry';
import { substitute } from './filters';
import { MetricBody, metricLabel } from './MetricCard';
import s from './Cards.module.css';

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

function Body({ card }: { card: Card }) {
  const ed = useEditor();
  if (card.type === 'visual') {
    const def = card.visualId ? ed.visuals.get(card.visualId) : undefined;
    // A dangling visualId degrades to a placeholder, never a crash (00-model.md §6.4).
    if (!def) return <Missing>The visual this card showed was deleted.</Missing>;
    return <VisualTileBody projectId={ed.projectId} def={def} filters={ed.filters} params={ed.params} />;
  }
  if (card.type === 'metric') return card.metric ? <MetricBody card={card} /> : <Missing>No metric</Missing>;
  if (card.type === 'text') {
    const text = substitute(card.text ?? '', ed.params);
    return (
      <div className={s.text}>
        {text.split(/\n{2,}/).map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>
    );
  }
  if (card.type === 'divider') return card.divider?.style === 'spacer' ? null : <hr className={s.divider} />;
  if (card.type === 'container' || card.type === 'tabs') {
    const tab = card.type === 'tabs' ? activeTab(card, ed.groupTab.get(card.id)) : undefined;
    const kids = childrenOf(ed.cards, card.id).filter((c) => !tab || c.tabId === tab);
    if (kids.length) return null;
    return <p className={s.groupEmpty}>{tab ? 'Drag cards into this tab.' : 'Drag cards in here — they move with it.'}</p>;
  }
  // Kinds drawn by other screens (navigation, image, statistics, summary): the record keeps them; the sheet says so.
  return (
    <div className={s.placeholder}>
      <Icon name="layout-dashboard" size={16} />
      <span>{KIND_TITLE[card.type] ?? card.type} card — shown when the dashboard is viewed.</span>
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
    <div className={s.tabs} role="tablist" aria-label="Tabs">
      {items.map((t, i) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          tabIndex={t.id === active ? 0 : -1}
          className={t.id === active ? `${s.tab} ${s.tabOn}` : s.tab}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            ed.setGroupTab(card.id, t.id);
          }}
          onKeyDown={(e) => {
            const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
            if (next === null) return;
            e.preventDefault();
            e.stopPropagation();
            const to = items[(next + items.length) % items.length];
            ed.setGroupTab(card.id, to.id);
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
}: {
  card: Card;
  menu: MenuEntry[];
  onHeadPointerDown: (e: React.PointerEvent) => void;
  handles: ReactNode;
  onKeyDown: (e: React.KeyboardEvent) => void;
  className: string;
  style: React.CSSProperties;
}) {
  const ed = useEditor();
  const title = cardTitle(card, ed);
  const folded = card.type === 'container' && !!card.container?.collapsible && ed.folded.has(card.id);
  const visualId = card.type === 'visual' ? card.visualId : undefined;
  return (
    <div
      className={className}
      style={style}
      data-card-id={card.id}
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
        <span className={s.ctrls} onPointerDown={(e) => e.stopPropagation()}>
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
      </div>
      {!folded && (
        <div className={s.body}>
          <Body card={card} />
        </div>
      )}
      {handles}
    </div>
  );
}
