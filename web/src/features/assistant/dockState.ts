// Where the dock is, and what it is about — dock.ts's view state and its
// section-aware context resolver (dkContextRef), for the web shell.
//
// OPEN is per browser (localStorage `ordinate.dock`, like the desktop's
// `dkOpen`), shared by the top bar's toggle and the panel through one tiny
// store, and the dock never opens itself: it remembers the user's choice.
//
// CONTEXT is read off the URL, never off "whatever was last open": an entity is
// in scope only while its own route is on screen, and everything else is the
// whole project — the rule dkContextRef was rewritten around, which a route
// gives for free. Which routes, and the id checks: ./dockRoute.ts.
//
// PROJECT: the URL's when it names one; otherwise the one picked in the dock,
// else the switcher's current project (features/projects/current), else the
// most recently opened.

import { useCallback, useSyncExternalStore } from 'react';
import { matchPath, useLocation } from 'react-router';
import { notifyManager, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useDatasetColumns } from '../../api/datasets';
import { useProjects, type Project } from '../../api/projects';
import { useCurrentProjectId } from '../projects/current';
import { useCapture } from '../import/api';
import { periodsBack } from '../reports/scorecards/period';
import type { Ask } from './api';
import { routeProject, routeScreen, type RouteScreen } from './dockRoute';

const OPEN_KEY = 'ordinate.dock';
const PROJECT_KEY = 'ordinate.dockProject';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: the default stands
  }
}
function write(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    // storage blocked: lasts for this page only
  }
}

const listeners = new Set<() => void>();
let open = read(OPEN_KEY) === '1';
let picked = read(PROJECT_KEY);

function emit(): void {
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function setDockOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  write(OPEN_KEY, next ? '1' : '0');
  emit();
}

export function useDockOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}

// A question handed over from outside the dock (homeAsk.ts dkAsk): the
// Assistant asks it as if typed, or, when it cannot ask yet (no project, no
// model), keeps it in the composer so nothing is lost. It may come pointed at
// one thing, as `@` points the dock: Home's suggestions do.
//
// Most doors hand it to the dock. Home's ask bar hands it to the full-width
// page (/assistant), which takes either kind: it is the dock, wide, and the dock
// is not drawn beside it. The dock takes only its own, so a dock still mounted
// for the moment Home navigates away never asks what was meant for the page.
export type HandedTo = 'dock' | 'page';
let question = '';
let about: HandedAbout | null = null;
let questionTo: HandedTo = 'dock';

/** What a handed question is about, in the project that thing lives in. */
export interface HandedAbout {
  projectId: string;
  context: DockContext;
}

function hand(q: string, on: HandedAbout | undefined, to: HandedTo): void {
  question = q.trim();
  about = on ?? null;
  questionTo = to;
  // Asked in the project the thing is in: off a project's own route, the picked project is the Assistant's.
  if (on) {
    picked = on.projectId;
    write(PROJECT_KEY, on.projectId);
  }
}

/** Opens the dock with `q` to ask; `on` points it at one thing first. */
export function openDockWith(q: string, on?: HandedAbout): void {
  hand(q, on, 'dock');
  open = true;
  write(OPEN_KEY, '1');
  emit();
}

/** Hands `q` to the full-width Assistant; the caller navigates to /assistant, which asks it. */
export function askOnPage(q: string, on?: HandedAbout): void {
  hand(q, on, 'page');
  emit();
}

/** The question waiting for the dock (or the page), if any. */
export function usePendingQuestion(where: HandedTo): string {
  return useSyncExternalStore(subscribe, () => (where === 'page' || questionTo === 'dock' ? question : ''));
}

/** The dock took the question: it is asked or in the composer now. */
export function takePendingQuestion(): { question: string; about: HandedAbout | null } {
  const taken = { question, about };
  question = '';
  about = null;
  if (taken.question) emit();
  return taken;
}

// A verified answer handed over from outside the Assistant (Home's chips): the full-width page opens in its project
// and runs the spec on the conversation it shows (`answer:rerun`), the same call a chip inside it makes.
export interface HandedSpec { spec: { datasetId: string } & Record<string, unknown>; label: string }
let handedSpec: HandedSpec | null = null;

/** Hands a verified answer to the full-width Assistant; the caller navigates to /assistant, which runs it. */
export function runOnPage(o: HandedSpec & { projectId: string }): void {
  handedSpec = { spec: o.spec, label: o.label };
  picked = o.projectId;
  write(PROJECT_KEY, o.projectId);
  emit();
}

/** The page's alone: a dock still open beside Home as it hands one over never runs it. */
export function usePendingSpec(where: HandedTo): HandedSpec | null {
  return useSyncExternalStore(subscribe, () => (where === 'page' ? handedSpec : null));
}

export function takePendingSpec(): HandedSpec | null {
  const taken = handedSpec;
  handedSpec = null;
  if (taken) emit();
  return taken;
}

// The conversation the full-width page last showed: the dock opens on it next (its "Back to the side panel", the top
// bar's toggle there), then forgets it. The other way, the dock's expand button puts its conversation in the URL.
let pageThread: { projectId: string; id: string } | null = null;

export function rememberPageThread(projectId: string, id: string): void {
  pageThread = { projectId, id };
}
/** Read on the dock's first render (pure, so a double render reads the same); dropped once it mounted. */
export function peekPageThread(): { projectId: string; id: string } | null {
  return pageThread;
}
export function forgetPageThread(): void {
  pageThread = null;
}

export function pickDockProject(id: string): void {
  picked = id;
  write(PROJECT_KEY, id);
  emit();
}

/** The most recently opened project first, as the desktop reopens it. */
function newest(list: readonly Project[]): Project | undefined {
  const at = (p: Project) => p.lastOpenedAt || p.updatedAt || p.createdAt;
  return [...list].filter((p) => !p.archivedAt).sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0))[0];
}

export interface DockProject {
  id: string | null;
  name: string;
  /** True when the URL decides it (no picker then). */
  fromRoute: boolean;
  projects: readonly Project[];
  loading: boolean;
}

export function useDockProject(enabled: boolean): DockProject {
  const chosen = useSyncExternalStore(subscribe, () => picked);
  const route = routeProject(useLocation().pathname);
  const current = useCurrentProjectId();
  const q = useProjects();
  const list = enabled ? (q.data ?? []) : [];
  // The dock's own pick, else the switcher's project, else the newest one.
  const id = route ?? [chosen, current].find((c) => c && list.some((p) => p.id === c)) ?? newest(list)?.id ?? null;
  return { id, name: list.find((p) => p.id === id)?.name ?? '', fromRoute: route !== null, projects: list, loading: q.isPending };
}

export interface DockContext extends Ask {
  /** "Based on …" — what the header says the answer is about. */
  label: string;
  /** The entity's name, for the starter prompts ('' for the whole project). */
  name: string;
}

const WHOLE: DockContext = { kind: '', label: 'whole project', name: '' };

const prop = (o: unknown, key: string): unknown => (typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined);

/**
 * Where the name of the thing on screen already is: the query its own page
 * reads — for a dataset, the project's list, which the dock itself reads
 * (Dock.tsx). So naming the context costs no call; dockScreens.test.tsx opens
 * each page and counts.
 */
function nameIn({ kind, projectId, id }: RouteScreen): { key: QueryKey; name(data: unknown): unknown } {
  switch (kind) {
    case 'dataset':
      return { key: ['dataset:list', projectId], name: (d) => prop(Array.isArray(d) ? d.find((x) => prop(x, 'id') === id) : null, 'name') };
    case 'visual':
      return { key: ['visual:get', projectId, id], name: (d) => prop(d, 'name') };
    case 'analysis':
      return { key: ['analysis:open', projectId, id], name: (d) => prop(prop(d, 'analysis'), 'name') };
    case 'scorecard':
      return { key: ['scorecard:get', projectId, id], name: (d) => prop(d, 'name') };
    case 'scenario':
      return { key: ['scenario:get', projectId, id], name: (d) => prop(d, 'name') };
    case 'capture':
      return { key: ['captureDataset:get', projectId, id], name: (d) => prop(d, 'title') };
  }
}

/** A cache entry as it stands: read, never asked for (an observer here refetches it every time the dock opens beside a loaded page). */
function useCached(key: QueryKey | null): unknown {
  const client = useQueryClient();
  const watch = useCallback((changed: () => void) => client.getQueryCache().subscribe(notifyManager.batchCalls(changed)), [client]);
  return useSyncExternalStore(watch, () => (key ? client.getQueryData(key) : undefined));
}

/** The dock's context from the route on screen. */
export function useDockContext(projectId: string | null): DockContext {
  const { pathname, search } = useLocation();
  const at = routeScreen(pathname);
  const on = at && at.projectId === projectId ? at : null;
  const source = on ? nameIn(on) : null;
  const cached = useCached(source ? source.key : null);
  // A dataset's own page and a capture's keep the observer they always had on the page's query: remembered open
  // across a load, the dock asks a moment before the page does and the page rides that one call. (Measured on
  // the dataset page: without it the page's later `dataset:list` no longer overlaps the dock's, one call more.)
  const ownPage = on?.kind === 'dataset' && matchPath('/data/:projectId/:datasetId', pathname) ? on.id : undefined;
  const cols = useDatasetColumns(projectId ?? undefined, ownPage);
  useCapture(projectId ?? '', on?.kind === 'capture' ? on.id : undefined);
  // No such screen — or its page looked and the thing is not there (deleted, refused): the server answers from the whole project then.
  if (!on || !source || cached === null || prop(cached, 'ok') === false) return WHOLE;
  // Until its page has loaded it (or when that failed) the thing is named by its kind.
  const found = cols.data?.name || source.name(cached);
  const name = typeof found === 'string' ? found : '';
  // A scorecard stepped back to an earlier period is asked about for THAT period (the page keeps it in the URL).
  const offset = on.kind === 'scorecard' ? periodsBack(new URLSearchParams(search)) : 0;
  return { kind: on.kind, id: on.id, label: `${on.kind} · ${name || `open ${on.kind}`}`, name, ...(offset ? { offset } : {}) };
}
