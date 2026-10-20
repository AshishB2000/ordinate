// The authoring workbench for one dashboard (legacy authoring.ts + the shared
// dashboards editor it re-parented): the top strip, the tool rail with its one
// flyout, and the sheet. Owns the document (undo / redo, a 600 ms autosave of
// the whole record — dashboards.ts persistAnalysis), and the view state that is
// never saved: the sheet on screen, the selection, the reader's live control
// and parameter values, the size shown.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { failure, type Analysis, type OpenReply, type SavedView, type Step, type VisualDef } from '../api';
import { mergeFilters } from '../VisualTile';
import { AddDialogs, type Adding } from './AddDialogs';
import { Canvas } from './Canvas';
import { EditorCtx, type EditorApi, type Pane, type Save, type SaveState } from './context';
import { allControls, fromAnalysis, initial, reduce, sheetOf, type Doc } from './doc';
import { clickFilterSteps, controlSteps, paramPayload } from './filters';
import type { FilterStep } from '../../visuals/api';
import { liveFilters } from '../../visuals/filters/filterText';
import { pickSize, type Size } from './geometry';
import { Head } from './Head';
import { Rail } from './Rail';
import s from './Editor.module.css';
import { useViewer } from '../../dashboards/useViewer';
import { DashboardChrome, styleClass, useStyleVars } from '../../dashboards/DashboardChrome';
import { isPhoneReader } from '../../dashboards/phone/phoneBlocks';
import { PhoneHead } from '../../dashboards/phone/PhoneHead';
import { gatherView, openingView, seedFromView } from '../../dashboards/views/viewState';
import { ConflictBanner } from '../../editConflicts/ConflictBanner';
import { useEditGuard } from '../../editConflicts/useEditGuard';

/** The autosave debounce (dashboards.ts): a drag fires several edits; one write. */
const SAVE_MS = 600;
const PANE_KEY = 'ordinate.anPane';

function storedPane(): Pane {
  try {
    const v = localStorage.getItem(PANE_KEY);
    return v === 'data' || v === 'visuals' || v === 'filters' || v === 'props' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the record and the server in step: one write per burst of edits, flushed on leave. Every write to the record —
 * this document save and a saved-view edit (views/useSavedViews) — waits its turn in ONE queue, the edit guard's
 * (editConflicts/useEditGuard): `analysis:update` re-reads the record it patches, so a save racing a view op could write
 * the view list back as it was. Each save sends the content tag the document was built on; when another tab or person
 * saved first it is refused, and from then on nothing is sent (`paused`) until the dashboard is reloaded.
 */
function useAutosave(projectId: string, id: string, doc: Doc, version: number, tag: string | undefined): Save & { changed: boolean } {
  const [state, setState] = useState<SaveState>('saved');
  const latest = useRef(doc);
  latest.current = doc;
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const client = useQueryClient();
  // Stable callbacks; `changed` flips once.
  const { save: guarded, queue, changed } = useEditGuard({ projectId, type: 'dashboard', id }, tag);

  const write = useCallback(() => {
    pending.current = null;
    const d = latest.current;
    setState('saving');
    return guarded((base) => rpc('analysis:update', { projectId, id, base, name: d.name, sheets: d.sheets, filters: d.filters, parameters: d.parameters, style: d.style }))
      .then(
        (r) => {
          if (r === null) return setState('paused'); // changed elsewhere: refused, or not sent
          const ok = !!(r && (r as { ok?: boolean }).ok);
          setState(ok ? 'saved' : 'error');
          if (!ok) return;
          void client.invalidateQueries({ queryKey: ['analysis:gallery', projectId] });
          // The name as saved, for whoever reads this page's record without owning it (the Assistant's header). The
          // editor took its document at mount and reads the record no further, so this reseeds nothing.
          client.setQueryData<OpenReply>(['analysis:open', projectId, id], (o) => (o?.ok ? { ...o, analysis: { ...o.analysis, name: d.name } } : o));
        },
        () => setState('error'),
      );
  }, [client, projectId, id, guarded]);

  const flush = useCallback(async () => {
    if (pending.current) {
      clearTimeout(pending.current);
      void write();
    }
    await queue(async () => undefined);
  }, [write, queue]);

  useEffect(() => {
    if (version === 0 || changed) return;
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => void write(), SAVE_MS);
    setState('saving');
  }, [version, write, changed]);

  // Changed elsewhere (a refused save, a view reply, the server's push): stop — the edit still waiting is never sent.
  useEffect(() => {
    if (!changed) return;
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    setState('paused');
  }, [changed]);

  // Leaving with an edit still waiting: write it now rather than drop it.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (pending.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.removeEventListener('beforeunload', warn);
      if (pending.current) {
        clearTimeout(pending.current);
        void write();
      }
    };
  }, [write]);

  return { state, retry: () => void write(), flush, queue, changed };
}

export function Editor({ projectId, analysis, visuals: initialVisuals, tag, onReload, readOnly = false }: {
  projectId: string;
  analysis: Analysis;
  visuals: VisualDef[];
  /** The record's content tag from `analysis:open`: the autosave's first base (docs/edit-conflicts). */
  tag?: string;
  /** The banner's Reload: the host reads the record again and mounts a new editor (editConflicts/useReload). */
  onReload?: () => void;
  readOnly?: boolean;
}) {
  const [history, dispatch] = useReducer(reduce, analysis, (a) => initial(fromAnalysis(a)));
  const doc = history.doc;
  const save = useAutosave(projectId, analysis.id, doc, history.version, tag);
  const conflict = useConflictActions(projectId, analysis.id, doc, onReload);
  // Saved views (dashboards/views): `?view=<id>`, else the default view, else the dashboard as authored.
  const [search, setSearch] = useSearchParams();
  const [opening] = useState(() => {
    const v = openingView(analysis.views ?? [], analysis.defaultViewId ?? '', search.get('view'));
    return { view: v, seed: seedFromView(v, analysis.sheets, analysis.parameters ?? []) };
  });
  const view = useViewer(projectId, analysis.id, opening.view ? opening.seed : null);
  const styleVars = useStyleVars(doc.style);
  const [views, setViews] = useState(() => ({ list: analysis.views ?? [], defaultId: analysis.defaultViewId ?? '' }));
  const [applied, setApplied] = useState(() => opening.view?.id ?? '');

  // A navigation's sheet, then `?sheet=<id>` (a navigation card's page target), beat the view's page.
  const [sheet, setSheetRaw] = useState(() => {
    const want = view.arrivedSheet ?? search.get('sheet');
    const at = analysis.sheets.findIndex((p) => p.id === want);
    return at >= 0 ? at : Math.max(0, opening.seed.sheet);
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [multi, setMulti] = useState<Set<string>>(() => new Set());
  const [pane, setPaneRaw] = useState<Pane>(storedPane);
  const [visuals, setVisuals] = useState(() => new Map(initialVisuals.map((v) => [v.id, v])));
  // The opening view's picks, else the author's defaults, are where a control starts (dashGrid.ts seeds controlState from them).
  const [controls, setControls] = useState(() => opening.seed.controls);
  const [paramLive, setParamLive] = useState(() => opening.seed.params);
  const [pinned, setPinned] = useState<Size | null>(null);
  const [width, setWidth] = useState(0);
  const [groupTab, setGroupTabs] = useState(() => opening.seed.groupTabs);
  const [folded, setFolded] = useState(() => new Set<string>());
  const [adding, setAdding] = useState<Adding>(null);

  const sheetIndex = Math.min(sheet, doc.sheets.length - 1);
  const cards = sheetOf(doc, sheetIndex).cards;
  const autoSize = pickSize(width);
  const size = pinned ?? autoSize;
  // A phone-wide dashboard nobody pinned is READ on a phone (docs/phone-dashboards): its own header, no tools.
  const phone = isPhoneReader({ size, pinned });

  const setPane = useCallback((p: Pane) => {
    setPaneRaw(p);
    try {
      localStorage.setItem(PANE_KEY, p ?? '');
    } catch {
      // private mode: the flyout still works, it just forgets
    }
  }, []);

  const select = useCallback(
    (id: string | null) => {
      if (readOnly || phone) return; // nothing to select a card FOR
      setSelected(id);
      // Selecting a card OPENS Properties — editing the card is why it was clicked.
      if (id) setPane('props');
    },
    [setPane, readOnly, phone],
  );

  const paramValue = useCallback(
    (id: string) => {
      if (paramLive.has(id)) return paramLive.get(id);
      return doc.parameters.find((p) => p.id === id)?.value ?? null;
    },
    [paramLive, doc.parameters],
  );

  const params = useMemo(() => paramPayload(doc.parameters, paramValue), [doc.parameters, paramValue]);
  const baseFilters = useMemo(() => {
    const steps = allControls(doc).flatMap((c) => (c.control ? controlSteps(c.control, controls.get(c.id)) : []));
    // A filter row still being set up (no operator yet) filters nothing (filterText.ts liveFilters).
    // The reader's selection (a navigation's carry, a map click) joins after the controls (dashboards.ts effectiveFilters).
    return mergeFilters(liveFilters(doc.filters as FilterStep[]), [...steps, ...view.selection]);
  }, [doc, controls, view.selection]);
  // Click-to-filter joins last. The card that was clicked reads the sheet WITHOUT its own clicks (filtersFor).
  const filters = useMemo(() => (view.clicks.length ? mergeFilters(baseFilters, clickFilterSteps(view.clicks)) : baseFilters), [baseFilters, view.clicks]);
  const ownFilters = useMemo(() => {
    const m = new Map<string, Step[]>();
    for (const c of view.clicks) if (!m.has(c.origin)) m.set(c.origin, mergeFilters(baseFilters, clickFilterSteps(view.clicks, c.origin)));
    return m;
  }, [baseFilters, view.clicks]);

  /** Name the view on screen in the address, in place (no history entry). */
  const nameInUrl = useCallback(
    (id: string) =>
      setSearch(
        (p) => {
          const next = new URLSearchParams(p);
          if (id) next.set('view', id);
          else next.delete('view');
          return next;
        },
        { replace: true },
      ),
    [setSearch],
  );
  /** Put a view's state on screen; null is the dashboard as authored, on the sheet already open. */
  const applyState = (v: SavedView | null) => {
    const seed = seedFromView(v, doc.sheets, doc.parameters);
    setControls(seed.controls);
    setParamLive(seed.params);
    setGroupTabs(seed.groupTabs);
    if (seed.sheet >= 0) {
      setSheetRaw(seed.sheet);
      setSelected(null);
      setMulti(new Set());
    }
    view.restore(seed.selection, seed.narrowed, seed.asOf);
  };

  const api: EditorApi = {
    projectId,
    analysisId: analysis.id,
    readOnly,
    history,
    doc,
    // The one door every change takes: shut for a viewer, so the document never changes and the autosave never writes.
    edit: (label, mutate, coalesce) => {
      if (!readOnly) dispatch({ type: 'edit', label, mutate, coalesce });
    },
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),
    save,
    sheet: sheetIndex,
    setSheet: (i) => {
      setSheetRaw(i);
      setSelected(null);
      setMulti(new Set());
      // A click-filter belongs to the sheet it was clicked on: its chart is not on the next one.
      view.clearClicks();
    },
    cards,
    selected: selected && cards.some((c) => c.id === selected) ? selected : null,
    select,
    multi,
    setMulti: (next) => {
      if (!readOnly) setMulti(next);
    },
    pane,
    setPane,
    openAdd: setAdding,
    visuals,
    addVisuals: (defs) => setVisuals((m) => new Map([...m, ...defs.map((v) => [v.id, v] as const)])),
    controlValue: (id) => controls.get(id),
    setControl: (id, v) =>
      setControls((m) => {
        const next = new Map(m);
        if (v === undefined) next.delete(id);
        else next.set(id, v);
        return next;
      }),
    paramValue,
    setParam: (id, v) => setParamLive((m) => new Map(m).set(id, v)),
    filters,
    filtersFor: (cardId) => ownFilters.get(cardId) ?? filters,
    params,
    size,
    pinned,
    // Clicking the size the pane would pick anyway goes back to following the pane.
    setPinned: (sz) => setPinned(sz === autoSize ? null : sz),
    groupTab,
    setGroupTab: (g, t) => setGroupTabs((m) => new Map(m).set(g, t)),
    folded,
    toggleFold: (g) =>
      setFolded((f) => {
        const next = new Set(f);
        if (next.has(g)) next.delete(g);
        else next.add(g);
        return next;
      }),
    view,
    views: {
      list: views.list,
      defaultId: views.defaultId,
      applied,
      apply: (id) => {
        const v = id ? (openingView(views.list, '', id) ?? undefined) : null;
        if (v === undefined) return;
        applyState(v);
        setApplied(v?.id ?? '');
        nameInUrl(v?.id ?? '');
      },
      gather: () =>
        gatherView({ sheets: doc.sheets, sheet: sheetIndex, controls, parameters: doc.parameters, params: paramLive, selection: view.selection, narrowed: view.narrowed, groupTabs: groupTab, asOf: view.asOf }),
      settle: (list, defaultId, now) => {
        setViews({ list, defaultId });
        setApplied(now);
        if (now !== applied) nameInUrl(now);
      },
    },
  };

  // ⌘Z / ⇧⌘Z (Ctrl on Windows/Linux) — never while typing in a field.
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) apiRef.current.redo();
        else apiRef.current.undo();
      } else if (e.key === 'Escape' && !e.defaultPrevented && apiRef.current.view.clicks.length) {
        // Esc clears every click-filter first; the next Esc lets go of the selected card.
        apiRef.current.view.clearClicks();
      } else if (e.key === 'Escape' && !e.defaultPrevented && (apiRef.current.selected || apiRef.current.multi.size)) {
        apiRef.current.select(null);
        apiRef.current.setMulti(new Set());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // `?view=` changed under an open dashboard (a ⌘K hit, Back / Forward): put that view on screen. One that names no
  // view, or the view already on screen, changes nothing — and "As authored" leaves the address without one.
  const wanted = search.get('view');
  useEffect(() => {
    const v = apiRef.current.views;
    if (wanted && wanted.toLowerCase() !== v.applied.toLowerCase() && openingView(v.list, '', wanted)) v.apply(wanted);
  }, [wanted]);

  return (
    <EditorCtx.Provider value={api}>
      <div className={`${s.editor} ${styleClass(doc.style, view.presenting)}`} style={styleVars} data-print-root="" data-phone={phone ? '' : undefined}>
        <DashboardChrome />
        {!view.presenting && (phone ? <PhoneHead /> : <Head />)}
        {save.changed && !readOnly && (
          <div className={s.conflict}>
            <ConflictBanner noun="dashboard" onReload={conflict.reload} onCopy={conflict.copy} />
          </div>
        )}
        <div className={s.bench}>
          {!view.presenting && !readOnly && !phone && <Rail />}
          <SheetHost onWidth={setWidth} reserve={phone && !readOnly ? RAIL_W : 0}>
            <Canvas />
          </SheetHost>
        </div>
        {!readOnly && <AddDialogs adding={adding} onClose={() => setAdding(null)} onSwitch={setAdding} />}
      </div>
    </EditorCtx.Provider>
  );
}

/** The banner's two ways on (editConflicts): drop my change and read the record again, or make my document a new dashboard. */
function useConflictActions(projectId: string, id: string, doc: Doc, onReload?: () => void) {
  const client = useQueryClient();
  const navigate = useNavigate();
  return {
    reload: onReload ?? (() => void client.resetQueries({ queryKey: ['analysis:open', projectId, id] })),
    copy: async () => {
      const made = (await rpc('analysis:create', {
        projectId, name: `${doc.name} (copy)`.slice(0, 200), sheets: doc.sheets, filters: doc.filters, parameters: doc.parameters, style: doc.style,
      })) as Analysis | { ok: false; error: string };
      if (!('id' in made)) throw new Error(failure(made, 'The copy could not be saved.'));
      void client.invalidateQueries({ queryKey: ['analysis:gallery', projectId] });
      await navigate(`/analyses/${projectId}/${made.id}`);
    },
  };
}

/** The rail's width (Editor.module.css .rail). */
const RAIL_W = 48;

/**
 * The sheet's column. The DASHBOARD's width — not the window's — picks the
 * layout size (layoutSizes.ts lyEditorWidth): the sheet plus an open flyout,
 * which is a tool laid over the pane for a moment and must not flip the
 * layout being edited. So: the bench, less the rail. An editor's rail steps
 * aside on a phone; `reserve` keeps its width counted, or hiding it would
 * widen the sheet across the phone line and bring it straight back.
 */
function SheetHost({ onWidth, reserve, children }: { onWidth: (w: number) => void; reserve: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const bench = el?.parentElement;
    if (!el || !bench) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      // A frame later: re-rendering inside the callback is how a ResizeObserver loop starts.
      cancelAnimationFrame(raf);
      // The rail is the bench's first child when there is one. A viewer has none — the first child is this sheet, and
      // subtracting it measured every viewer's dashboard 0 wide: the desktop grid on any screen, a phone's included.
      raf = requestAnimationFrame(() => {
        const first = bench.firstElementChild as HTMLElement | null;
        onWidth(bench.clientWidth - (first && first !== el ? first.offsetWidth : reserve));
      });
    });
    ro.observe(bench);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [onWidth, reserve]);
  return (
    <div ref={ref} className={s.sheet}>
      {children}
    </div>
  );
}
