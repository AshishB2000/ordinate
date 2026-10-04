// What every part of the open editor reads: the document and how to edit it,
// the view state that is never saved (which sheet, which card is selected, the
// reader's live control and parameter values, which size is shown), and the
// project's visuals. One context, provided by Editor.tsx.

import { createContext, useContext } from 'react';
import type { Card, ControlValue, ParamPayload, Step, VisualDef } from '../api';
import type { Doc, History } from './doc';
import type { Size } from './geometry';
import type { Adding } from './AddDialogs';

export type Pane = 'data' | 'visuals' | 'filters' | 'props' | null;
export type SaveState = 'saved' | 'saving' | 'error';

export interface EditorApi {
  projectId: string;
  analysisId: string;
  history: History;
  doc: Doc;
  /** One labelled, undoable change. `coalesce`: a keystroke in a field (one step per burst). */
  edit(label: string, mutate: (d: Doc) => void, coalesce?: boolean): void;
  undo(): void;
  redo(): void;
  save: { state: SaveState; retry(): void };

  sheet: number;
  setSheet(i: number): void;
  cards: Card[];
  selected: string | null;
  select(id: string | null): void;
  multi: ReadonlySet<string>;
  setMulti(next: Set<string>): void;
  pane: Pane;
  setPane(p: Pane): void;
  /** Open one of the add flows (AddDialogs.tsx). */
  openAdd(a: NonNullable<Adding>): void;

  visuals: ReadonlyMap<string, VisualDef>;
  addVisuals(defs: VisualDef[]): void;

  /** A control's live selection (never saved); undefined = All. */
  controlValue(cardId: string): ControlValue | undefined;
  setControl(cardId: string, v: ControlValue | undefined): void;
  /** A parameter's live value (never saved); falls back to its default. */
  paramValue(paramId: string): unknown;
  setParam(paramId: string, v: unknown): void;
  /** The dashboard filters + every control's live selection, as filter steps. */
  filters: Step[];
  params: ParamPayload;

  size: Size;
  pinned: Size | null;
  setPinned(s: Size | null): void;
  groupTab: ReadonlyMap<string, string>;
  setGroupTab(groupId: string, tabId: string): void;
  folded: ReadonlySet<string>;
  toggleFold(groupId: string): void;
}

export const EditorCtx = createContext<EditorApi | null>(null);

export function useEditor(): EditorApi {
  const e = useContext(EditorCtx);
  if (!e) throw new Error('useEditor() outside the dashboard editor');
  return e;
}
