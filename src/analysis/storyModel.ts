// The STORY record's shape — MAIN PROCESS, PURE: no fs, no Electron.
//
// A story is a single scrolling document: an ordered list of blocks, some of
// which are prose and some of which are LIVE references to the project's own
// charts and metrics. A visual or metric block stores an id (and optionally
// filters pinned to that block, and a caption), never a figure: the page
// computes every number when it renders, exactly like a dashboard card, so a
// refreshed dataset moves the story with it.
//
// This file is the whitelist every block passes through on the way in AND on
// the way out of disk. The rule is the one every store here follows: unknown
// keys are dropped, enums are clamped, a block that cannot be made valid is
// dropped rather than trusted — and a story always keeps at least one block,
// so the editor never opens on nothing.

import { randomUUID } from 'crypto';
import type { FilterStep } from '../data/transforms';
import { sanitizeSteps } from '../data/transforms';

export type StoryBlockKind = 'text' | 'visual' | 'metric' | 'metrics_row' | 'image' | 'divider' | 'callout';
export const STORY_BLOCK_KINDS: readonly StoryBlockKind[] = ['text', 'visual', 'metric', 'metrics_row', 'image', 'divider', 'callout'];

export type CalloutTone = 'info' | 'success' | 'warning' | 'danger';
const TONES: ReadonlySet<string> = new Set(['info', 'success', 'warning', 'danger']);

interface Base { id: string }
export interface TextBlock extends Base { kind: 'text'; text: string }
export interface VisualBlock extends Base {
  kind: 'visual';
  visualId: string;
  /** Filters pinned to THIS block, applied on top of the visual's own. */
  filters: FilterStep[];
  /** The author's caption; absent means the app's own (captions.ts). */
  caption?: string;
}
export interface MetricBlock extends Base { kind: 'metric'; metricId: string; filters: FilterStep[]; caption?: string }
export interface MetricsRowBlock extends Base { kind: 'metrics_row'; metricIds: string[]; filters: FilterStep[] }
export interface ImageBlock extends Base { kind: 'image'; src: string; alt: string; caption?: string }
export interface DividerBlock extends Base { kind: 'divider' }
export interface CalloutBlock extends Base { kind: 'callout'; tone: CalloutTone; text: string }

export type StoryBlock = TextBlock | VisualBlock | MetricBlock | MetricsRowBlock | ImageBlock | DividerBlock | CalloutBlock;

/** Longest prose one text or callout block may hold. A chapter, not a book. */
export const MAX_TEXT = 20_000;
export const MAX_CAPTION = 400;
export const MAX_BLOCKS = 400;
export const MAX_ROW_METRICS = 4;
/**
 * The largest image a story may embed, as a data: URL. Stories live in one
 * JSON file that is rewritten on every save, so a picture is bounded like one.
 */
export const MAX_IMAGE_CHARS = 2_800_000; // ≈ 2 MB of image

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Raster images only — an SVG data: URL is a document that can carry script.
const IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function optCaption(v: unknown): string | undefined {
  return typeof v === 'string' ? v.slice(0, MAX_CAPTION) : undefined;
}

function filtersOf(v: unknown): FilterStep[] {
  return sanitizeSteps(v).filter((s): s is FilterStep => s.type === 'filter');
}

/**
 * One untrusted block → a valid block, or null. A missing or malformed id is
 * REPLACED, not rejected: ids are the editor's keys, never paths, and a block
 * pasted from somewhere else should survive with a fresh one.
 */
export function sanitizeBlock(raw: unknown): StoryBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.id) ? o.id : randomUUID();
  switch (o.kind) {
    case 'text':
      return { id, kind: 'text', text: str(o.text, MAX_TEXT) };
    case 'callout':
      return { id, kind: 'callout', tone: typeof o.tone === 'string' && TONES.has(o.tone) ? o.tone as CalloutTone : 'info', text: str(o.text, MAX_TEXT) };
    case 'divider':
      return { id, kind: 'divider' };
    case 'visual': {
      if (typeof o.visualId !== 'string' || !UUID_RE.test(o.visualId)) return null;
      const b: VisualBlock = { id, kind: 'visual', visualId: o.visualId, filters: filtersOf(o.filters) };
      const cap = optCaption(o.caption);
      if (cap !== undefined) b.caption = cap;
      return b;
    }
    case 'metric': {
      if (typeof o.metricId !== 'string' || !UUID_RE.test(o.metricId)) return null;
      const b: MetricBlock = { id, kind: 'metric', metricId: o.metricId, filters: filtersOf(o.filters) };
      const cap = optCaption(o.caption);
      if (cap !== undefined) b.caption = cap;
      return b;
    }
    case 'metrics_row': {
      const ids = (Array.isArray(o.metricIds) ? o.metricIds : [])
        .filter((x): x is string => typeof x === 'string' && UUID_RE.test(x));
      const unique = ids.filter((x, i) => ids.indexOf(x) === i).slice(0, MAX_ROW_METRICS);
      if (!unique.length) return null;
      return { id, kind: 'metrics_row', metricIds: unique, filters: filtersOf(o.filters) };
    }
    case 'image': {
      if (typeof o.src !== 'string' || o.src.length > MAX_IMAGE_CHARS || !IMAGE_RE.test(o.src)) return null;
      const b: ImageBlock = { id, kind: 'image', src: o.src, alt: str(o.alt, MAX_CAPTION) };
      const cap = optCaption(o.caption);
      if (cap !== undefined) b.caption = cap;
      return b;
    }
    default:
      return null;
  }
}

/** A block list → valid blocks, ids unique, never empty (one empty text block). */
export function sanitizeBlocks(raw: unknown): StoryBlock[] {
  const out: StoryBlock[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw.slice(0, MAX_BLOCKS) : []) {
    const b = sanitizeBlock(item);
    if (!b) continue;
    if (seen.has(b.id)) b.id = randomUUID();
    seen.add(b.id);
    out.push(b);
  }
  if (!out.length) out.push({ id: randomUUID(), kind: 'text', text: '' });
  return out;
}

/** The ids of every visual and metric a story references — for usage counts and cleanup. */
export function storyRefs(blocks: StoryBlock[]): { visualIds: string[]; metricIds: string[] } {
  const visualIds: string[] = [];
  const metricIds: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'visual' && !visualIds.includes(b.visualId)) visualIds.push(b.visualId);
    if (b.kind === 'metric' && !metricIds.includes(b.metricId)) metricIds.push(b.metricId);
    if (b.kind === 'metrics_row') b.metricIds.forEach((m) => { if (!metricIds.includes(m)) metricIds.push(m); });
  }
  return { visualIds, metricIds };
}

/** A new story's first blocks: a title heading and an empty paragraph to type into. */
export function starterBlocks(name: string): StoryBlock[] {
  return [
    { id: randomUUID(), kind: 'text', text: '# ' + (name.replace(/\s+/g, ' ').trim() || 'Untitled story') },
    { id: randomUUID(), kind: 'text', text: '' },
  ];
}
