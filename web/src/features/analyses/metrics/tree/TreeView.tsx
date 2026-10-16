// A metric tree drawn top-down: DOM cards, and between a parent and its
// children an inline SVG of connectors measured from where the cards actually
// landed (flex layout, so a wide subtree pushes its siblings without any
// arithmetic here). The lead branch — the server's `lead` flags — is tinted and
// thicker from the root down. On a narrow screen the same tree reads as an
// indented outline (CSS only).
//
// Keyboard (the ARIA tree pattern): ↑ ↓ move through the visible nodes, →
// opens a node or goes to its first child, ← closes it or goes to its parent,
// Enter / Space toggle, Home / End. One node is in the tab order at a time.

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Skeleton } from '../../../../ui/Skeleton';
import type { TreeNode } from './api';
import { NodeCard, nodeLabel, toneOf, type Tone } from './NodeCard';
import s from './MetricTree.module.css';

/** Open by default: the first two levels, and every node on the lead branch. */
function defaultOpen(n: TreeNode, depth: number): boolean {
  return depth < 2 || !!n.lead;
}

interface Edge {
  x: number;
  lead: boolean;
  tone: Tone;
}

const EDGE_H = 36;
const TONE_STROKE: Record<Tone, string> = { good: s.edgeGood, bad: s.edgeBad, neutral: s.edgeNeutral };

/** The connectors from a parent (centred above) down to each child card. */
function Connectors({ row, kids, parent }: { row: React.RefObject<HTMLDivElement | null>; kids: TreeNode[]; parent: TreeNode }) {
  const [shape, setShape] = useState<{ w: number; edges: Edge[] } | null>(null);
  const measure = useCallback(() => {
    const el = row.current;
    if (!el) return;
    const cards = Array.from(el.children).map((c) => c.querySelector<HTMLElement>(':scope > [data-card]'));
    const edges = cards.map((c, i) => ({
      x: c ? c.offsetLeft + c.offsetWidth / 2 : 0,
      lead: !!kids[i]?.lead && !!parent.lead,
      tone: toneOf(parent.direction, kids[i]?.contribution),
    }));
    setShape((prev) => (prev && prev.w === el.clientWidth && JSON.stringify(prev.edges) === JSON.stringify(edges) ? prev : { w: el.clientWidth, edges }));
  }, [row, kids, parent]);
  useLayoutEffect(() => {
    measure();
    const el = row.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => ro.disconnect();
  }, [measure, row]);
  if (!shape || !shape.w) return <div className={s.edges} aria-hidden="true" />;
  const px = shape.w / 2;
  const mid = EDGE_H / 2;
  // The lead edge is drawn last, so it sits on top where the curves meet.
  const order = shape.edges.map((e, i) => ({ e, i })).sort((a, b) => Number(a.e.lead) - Number(b.e.lead));
  return (
    <svg className={s.edges} width={shape.w} height={EDGE_H} viewBox={`0 0 ${shape.w} ${EDGE_H}`} aria-hidden="true" focusable="false">
      {order.map(({ e, i }) => (
        <path
          key={i}
          d={`M${px},0 C${px},${mid} ${e.x},${mid} ${e.x},${EDGE_H}`}
          className={e.lead ? `${s.edge} ${s.edgeLead} ${TONE_STROKE[e.tone]}` : s.edge}
        />
      ))}
    </svg>
  );
}

function Subtree({
  node,
  depth,
  parent,
  open,
  setOpen,
  focusKey,
  inList,
  shareScale,
}: {
  node: TreeNode;
  depth: number;
  parent?: TreeNode;
  open: Map<string, boolean>;
  setOpen: (key: string, v: boolean) => void;
  focusKey: string;
  /** A row of its parent's split list. */
  inList?: boolean;
  shareScale?: number;
}) {
  const row = useRef<HTMLDivElement>(null);
  const kids = node.children;
  const isOpen = kids.length > 0 && (open.get(node.key) ?? defaultOpen(node, depth));
  // A split's segments are a ranked list under their parent; a formula's parts branch sideways.
  const list = node.breakdown?.kind === 'split';
  const scale = Math.max(100, ...kids.map((k) => (typeof k.share === 'number' && Number.isFinite(k.share) ? Math.abs(k.share) : 0)));
  return (
    <div
      className={inList ? `${s.subtree} ${s.inList}` : s.subtree}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={kids.length ? isOpen : undefined}
      aria-label={nodeLabel(node)}
      tabIndex={node.key === focusKey ? 0 : -1}
      data-key={node.key}
      data-subtree=""
    >
      <NodeCard
        node={node}
        parentDirection={parent?.direction}
        root={depth === 0}
        open={isOpen}
        onToggle={kids.length ? () => setOpen(node.key, !isOpen) : undefined}
        row={inList}
        shareScale={shareScale}
      />
      {isOpen && (
        <>
          <div className={list ? s.segList : s.children} role="group" ref={row}>
            {kids.map((k) => (
              <Subtree key={k.key} node={k} depth={depth + 1} parent={node} open={open} setOpen={setOpen} focusKey={focusKey} inList={list} shareScale={scale} />
            ))}
          </div>
          {/* After the row, so its ref is attached when this measures; CSS `order` draws it above. */}
          <Connectors row={row} kids={kids} parent={node} />
        </>
      )}
    </div>
  );
}

export function TreeView({ root, label }: { root: TreeNode; label: string }) {
  const [open, setOpenMap] = useState<Map<string, boolean>>(() => new Map());
  const [focusKey, setFocusKey] = useState(root.key);
  const box = useRef<HTMLDivElement>(null);
  const setOpen = useCallback((key: string, v: boolean) => setOpenMap((m) => new Map(m).set(key, v)), []);
  // The focused node may vanish (its parent closed, a new tree): the root takes the tab stop.
  const keys = useMemo(() => {
    const out = new Set<string>();
    const walk = (n: TreeNode): void => {
      out.add(n.key);
      n.children.forEach(walk);
    };
    walk(root);
    return out;
  }, [root]);
  const current = keys.has(focusKey) ? focusKey : root.key;
  // A tree wider than its box opens centred on the root, not on its leftmost leaf.
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(box.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []);
    const at = items.findIndex((el) => el === document.activeElement);
    if (at < 0) return;
    const el = items[at];
    const key = el.dataset.key as string;
    const expanded = el.getAttribute('aria-expanded');
    const go = (target: HTMLElement | null | undefined) => {
      if (!target) return;
      setFocusKey(target.dataset.key as string);
      target.focus();
    };
    let handled = true;
    if (e.key === 'ArrowDown') go(items[at + 1]);
    else if (e.key === 'ArrowUp') go(items[at - 1]);
    else if (e.key === 'Home') go(items[0]);
    else if (e.key === 'End') go(items[items.length - 1]);
    else if (e.key === 'ArrowRight') {
      if (expanded === 'false') setOpen(key, true);
      else if (expanded === 'true') go(el.querySelector<HTMLElement>(':scope > [role="group"] > [role="treeitem"]'));
    } else if (e.key === 'ArrowLeft') {
      if (expanded === 'true') setOpen(key, false);
      else go(el.parentElement?.closest<HTMLElement>('[role="treeitem"]'));
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (expanded !== null) setOpen(key, expanded !== 'true');
    } else handled = false;
    if (handled) e.preventDefault();
  };

  return (
    <div className={s.scroller} ref={scroller}>
      <div className={s.tree} role="tree" aria-label={label} ref={box} onKeyDown={onKeyDown} onFocus={(e) => {
        const k = (e.target as HTMLElement).dataset?.key;
        if (k) setFocusKey(k);
      }}>
        <Subtree node={root} depth={0} open={open} setOpen={setOpen} focusKey={current} />
      </div>
    </div>
  );
}

/** The tree's loading state: its shape, before the figures. */
export function TreeSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div className={s.skTree} aria-busy="true" aria-label="Computing the tree">
      <Skeleton className={s.skCard} />
      <div className={s.skRow}>
        <Skeleton className={s.skCard} />
        <Skeleton className={s.skCard} />
      </div>
      {!compact && (
        <div className={s.skRow}>
          <Skeleton className={s.skSmall} />
          <Skeleton className={s.skSmall} />
          <Skeleton className={s.skSmall} />
          <Skeleton className={s.skSmall} />
        </div>
      )}
    </div>
  );
}
