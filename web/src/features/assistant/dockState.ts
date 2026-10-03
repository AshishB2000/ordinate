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
// gives for free. Screens that port later add their routes here.
//
// PROJECT: the URL's when it names one; otherwise the one picked in the dock,
// else the most recently opened. ponytail: the shell has no current project
// yet — this becomes T2.2's project switcher's value when it lands.

import { useSyncExternalStore } from 'react';
import { useMatch } from 'react-router';
import { useDatasetColumns } from '../../api/datasets';
import { useProjects, type Project } from '../../api/projects';
import type { Ask } from './api';

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
  const route = useMatch('/data/:projectId/*')?.params.projectId ?? null;
  const q = useProjects();
  const list = enabled ? (q.data ?? []) : [];
  const id = route ?? (chosen && list.some((p) => p.id === chosen) ? chosen : (newest(list)?.id ?? null));
  return { id, name: list.find((p) => p.id === id)?.name ?? '', fromRoute: route !== null, projects: list, loading: q.isPending };
}

export interface DockContext extends Ask {
  /** "Based on …" — what the header says the answer is about. */
  label: string;
  /** The entity's name, for the starter prompts ('' for the whole project). */
  name: string;
}

const WHOLE: DockContext = { kind: '', label: 'whole project', name: '' };

/** The dock's context from the route on screen. */
export function useDockContext(projectId: string | null): DockContext {
  const ds = useMatch('/data/:projectId/:datasetId');
  const datasetId = ds && ds.params.projectId === projectId ? (ds.params.datasetId ?? null) : null;
  // The same query (and cache entry) the dataset page's grid header reads.
  const cols = useDatasetColumns(projectId ?? undefined, datasetId ?? undefined);
  if (!datasetId) return WHOLE;
  const name = cols.data?.name || 'open dataset';
  return { kind: 'dataset', id: datasetId, label: `dataset · ${name}`, name: cols.data?.name ?? '' };
}
