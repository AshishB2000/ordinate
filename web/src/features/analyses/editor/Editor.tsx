// The authoring workbench for one dashboard (legacy authoring.ts + the shared
// dashboards editor it re-parented): the top strip, the tool rail with its one
// flyout, and the sheet. Owns the document (undo / redo, a 600 ms autosave of
// the whole record — dashboards.ts persistAnalysis), and the view state that is
// never saved: the sheet on screen, the selection, the reader's live control
// and parameter values, the size shown.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import type { Analysis, ControlValue, VisualDef } from '../api';
import { mergeFilters } from '../VisualTile';
import { AddDialogs, type Adding } from './AddDialogs';
import { Canvas } from './Canvas';
import { EditorCtx, type EditorApi, type Pane, type SaveState } from './context';
import { allControls, fromAnalysis, initial, reduce, sheetOf, type Doc } from './doc';
import { controlSteps, paramPayload } from './filters';
import type { FilterStep } from '../../visuals/api';
import { liveFilters } from '../../visuals/filters/filterText';
import { pickSize, type Size } from './geometry';
import { Head } from './Head';
import { Rail } from './Rail';
import s from './Editor.module.css';

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

/** Keeps the record and the server in step: one write per burst of edits, flushed on leave. */
function useAutosave(projectId: string, id: string, doc: Doc, version: number): { state: SaveState; retry(): void } {
  const [state, setState] = useState<SaveState>('saved');
  const latest = useRef(doc);
  latest.current = doc;
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const client = useQueryClient();

  const write = useCallback(() => {
    pending.current = null;
    const d = latest.current;
    setState('saving');
    rpc('analysis:update', { projectId, id, name: d.name, sheets: d.sheets, filters: d.filters, parameters: d.parameters }).then(
      (r) => {
        const ok = !!(r && (r as { ok?: boolean }).ok);
        setState(ok ? 'saved' : 'error');
        if (ok) void client.invalidateQueries({ queryKey: ['analysis:gallery', projectId] });
      },
      () => setState('error'),
    );
  }, [client, projectId, id]);

  useEffect(() => {
    if (version === 0) return;
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(write, SAVE_MS);
    setState('saving');
  }, [version, write]);

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
        write();
      }
    };
  }, [write]);

  return { state, retry: write };
}

export function Editor({ projectId, analysis, visuals: initialVisuals }: { projectId: string; analysis: Analysis; visuals: VisualDef[] }) {
  const [history, dispatch] = useReducer(reduce, analysis, (a) => initial(fromAnalysis(a)));
  const doc = history.doc;
  const save = useAutosave(projectId, analysis.id, doc, history.version);

  // `?sheet=<id>`: a navigation card's page target opens on that sheet.
  const [sheet, setSheetRaw] = useState(() => {
    const want = new URLSearchParams(window.location.search).get('sheet');
    return Math.max(0, analysis.sheets.findIndex((p) => p.id === want));
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [multi, setMulti] = useState<Set<string>>(() => new Set());
  const [pane, setPaneRaw] = useState<Pane>(storedPane);
  const [visuals, setVisuals] = useState(() => new Map(initialVisuals.map((v) => [v.id, v])));
  // The author's defaults are where a control starts (dashGrid.ts seeds controlState from them).
  const [controls, setControls] = useState(() => {
    const m = new Map<string, ControlValue>();
    for (const c of allControls(fromAnalysis(analysis))) if (c.control?.default) m.set(c.id, c.control.default);
    return m;
  });
  const [paramLive, setParamLive] = useState(() => new Map<string, unknown>());
  const [pinned, setPinned] = useState<Size | null>(null);
  const [width, setWidth] = useState(0);
  const [groupTab, setGroupTabs] = useState(() => new Map<string, string>());
  const [folded, setFolded] = useState(() => new Set<string>());
  const [adding, setAdding] = useState<Adding>(null);

  const sheetIndex = Math.min(sheet, doc.sheets.length - 1);
  const cards = sheetOf(doc, sheetIndex).cards;
  const autoSize = pickSize(width);
  const size = pinned ?? autoSize;

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
      setSelected(id);
      // Selecting a card OPENS Properties — editing the card is why it was clicked.
      if (id) setPane('props');
    },
    [setPane],
  );

  const paramValue = useCallback(
    (id: string) => {
      if (paramLive.has(id)) return paramLive.get(id);
      return doc.parameters.find((p) => p.id === id)?.value ?? null;
    },
    [paramLive, doc.parameters],
  );

  const params = useMemo(() => paramPayload(doc.parameters, paramValue), [doc.parameters, paramValue]);
  const filters = useMemo(() => {
    const steps = allControls(doc).flatMap((c) => (c.control ? controlSteps(c.control, controls.get(c.id)) : []));
    // A filter row still being set up (no operator yet) filters nothing (filterText.ts liveFilters).
    return mergeFilters(liveFilters(doc.filters as FilterStep[]), steps);
  }, [doc, controls]);

  const api: EditorApi = {
    projectId,
    analysisId: analysis.id,
    history,
    doc,
    edit: (label, mutate, coalesce) => dispatch({ type: 'edit', label, mutate, coalesce }),
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),
    save,
    sheet: sheetIndex,
    setSheet: (i) => {
      setSheetRaw(i);
      setSelected(null);
      setMulti(new Set());
    },
    cards,
    selected: selected && cards.some((c) => c.id === selected) ? selected : null,
    select,
    multi,
    setMulti,
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
      } else if (e.key === 'Escape' && !e.defaultPrevented && (apiRef.current.selected || apiRef.current.multi.size)) {
        apiRef.current.select(null);
        apiRef.current.setMulti(new Set());
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <EditorCtx.Provider value={api}>
      <div className={s.editor}>
        <Head />
        <div className={s.bench}>
          <Rail />
          <SheetHost onWidth={setWidth}>
            <Canvas />
          </SheetHost>
        </div>
        <AddDialogs adding={adding} onClose={() => setAdding(null)} onSwitch={setAdding} />
      </div>
    </EditorCtx.Provider>
  );
}

/**
 * The sheet's column. The DASHBOARD's width — not the window's — picks the
 * layout size (layoutSizes.ts lyEditorWidth): the sheet plus an open flyout,
 * which is a tool laid over the pane for a moment and must not flip the
 * layout being edited. So: the bench, less the rail.
 */
function SheetHost({ onWidth, children }: { onWidth: (w: number) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const bench = el?.parentElement;
    if (!el || !bench) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      // A frame later: re-rendering inside the callback is how a ResizeObserver loop starts.
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => onWidth(bench.clientWidth - ((bench.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0)));
    });
    ro.observe(bench);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [onWidth]);
  return (
    <div ref={ref} className={s.sheet}>
      {children}
    </div>
  );
}
