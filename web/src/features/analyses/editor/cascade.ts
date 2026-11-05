// The controls whose picks narrow a picker (p6-05, D12): those on higher levels of the hierarchy that holds the
// picker's column, same dataset. Pure and view-side; the server narrows (dataset:distinct `filters`).

import { levelOf, type NavHierarchy } from '../../../../../src/analysis/drillLevels.ts';
import type { Card, ControlValue, Step } from '../api';
import { controlSteps } from './filters';

type Control = NonNullable<Card['control']>;
export interface Sibling { control: Control; value: ControlValue | undefined }
export interface Cascade { steps: Step[]; by: { label: string; summary: string }[] } // nearest parent last

const NONE: Cascade = { steps: [], by: [] };

/** Dropdown and multi parents only: a date range or a parameter is not a level. */
export function cascadeOf(control: Control, siblings: readonly Sibling[], hierarchies: readonly NavHierarchy[]): Cascade {
  const at = levelOf(hierarchies, control.column);
  if (!at || at.index === 0) return NONE;
  const parents = siblings
    .map((s) => ({ s, level: s.control.datasetId === control.datasetId && (s.control.kind === 'dropdown' || s.control.kind === 'multi') ? at.hierarchy.levels.indexOf(s.control.column) : -1 }))
    .filter((p) => p.level >= 0 && p.level < at.index && controlSteps(p.s.control, p.s.value).length > 0)
    .sort((a, b) => a.level - b.level);
  return {
    steps: parents.flatMap((p) => controlSteps(p.s.control, p.s.value)),
    by: parents.map((p) => ({ label: p.s.control.label || p.s.control.column, summary: summaryOf(p.s.value) })),
  };
}

const summaryOf = (v: ControlValue | undefined): string => (v && 'values' in v ? v.values.join(', ') : v && 'value' in v ? v.value : '');
