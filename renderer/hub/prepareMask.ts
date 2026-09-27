'use strict';

// The three MASK steps in the Prepare editor — their forms and their one-line
// summaries. Split from prepare.ts, which sits near its line cap: its
// STEP_TYPES lists the three types, and its stepSummaryText / buildStepForm
// fall through to here for them. The masking itself runs in main
// (src/data/maskSteps.ts); nothing here computes a masked value.
//
// Classic global-scope renderer <script>: no import/export. Loads after
// prepare.js (it uses makeColSelect / fieldRow / selectFrom from there).

/** A column to preselect when the editor is opened from a sensitivity prompt. */
let pvMaskPrefill = '';

const PV_GENERALIZE_MODES: Array<[string, string]> = [
  ['bucket', 'Bucket numbers'],
  ['month', 'Truncate dates to the month'],
  ['domain', 'Keep only the email domain'],
];

/** The pipeline row's sentence for a mask step, or null for any other step. */
function pvMaskSummary(step: any): string | null {
  if (!step || typeof step.type !== 'string') return null;
  const col = String(step.column || '');
  switch (step.type) {
    case 'mask_hash':
      return `Mask ${col}: hash to tokens`;
    case 'mask_redact': {
      const keep = Number.isFinite(Number(step.keep)) ? Number(step.keep) : 4;
      return keep > 0 ? `Mask ${col}: keep last ${keep}` : `Mask ${col}: hide all`;
    }
    case 'mask_generalize':
      if (step.mode === 'month') return `Mask ${col}: month only`;
      if (step.mode === 'domain') return `Mask ${col}: domain only`;
      return `Mask ${col}: buckets of ${Number(step.size) > 0 ? Number(step.size).toLocaleString() : 10}`;
    default:
      return null;
  }
}

function pvMaskHint(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'pv-mask-hint';
  p.textContent = text;
  return p;
}

function pvNumberInput(value: number, min: number, max?: number, step = 'any'): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'number';
  i.className = 'ds-step-input pv-mask-num';
  i.min = String(min);
  if (max !== undefined) i.max = String(max);
  i.step = step;
  i.value = String(value);
  return i;
}

/**
 * The form for a mask step, or null when `type` is not one. Returns the same
 * kind of getter prepare.ts's forms do: the step object, or null after telling
 * the user what is missing.
 */
function pvBuildMaskForm(type: string, body: HTMLElement, existing: any): (() => any) | null {
  if (type !== 'mask_hash' && type !== 'mask_redact' && type !== 'mask_generalize') return null;
  const colSel = makeColSelect(existing ? existing.column : pvMaskPrefill || undefined);
  pvMaskPrefill = '';
  body.appendChild(fieldRow('Column', colSel));
  const need = (): string | null => {
    if (colSel.value) return colSel.value;
    window.alert('Pick a column to mask.');
    return null;
  };

  if (type === 'mask_hash') {
    body.appendChild(pvMaskHint('Each value becomes a short token like #3f9a0c21b7d4 — the same token for the same value everywhere in this project, so counts, joins and groupings still work. The key that makes the tokens stays in this project\'s folder and never leaves it.'));
    return () => {
      const column = need();
      return column ? { type, column } : null;
    };
  }

  if (type === 'mask_redact') {
    const keep = pvNumberInput(existing && Number.isFinite(Number(existing.keep)) ? Number(existing.keep) : 4, 0, 8, '1');
    body.appendChild(fieldRow('Characters to keep', keep));
    const hint = pvMaskHint('');
    const paint = (): void => {
      const k = Math.max(0, Math.min(8, Math.floor(Number(keep.value) || 0)));
      const sample = '4111111111111234';
      hint.textContent = k > 0
        ? `${sample} becomes •••${sample.slice(-k)}. A value no longer than ${k} characters is hidden whole.`
        : 'Every value becomes •••.';
    };
    keep.addEventListener('input', paint);
    paint();
    body.appendChild(hint);
    return () => {
      const column = need();
      return column ? { type, column, keep: Math.max(0, Math.min(8, Math.floor(Number(keep.value) || 0))) } : null;
    };
  }

  // mask_generalize
  const mode = selectFrom(PV_GENERALIZE_MODES.map((m) => m[0]), existing && existing.mode ? String(existing.mode) : 'bucket');
  mode.querySelectorAll('option').forEach((o) => {
    const m = PV_GENERALIZE_MODES.find((x) => x[0] === o.value);
    if (m) o.textContent = m[1];
  });
  body.appendChild(fieldRow('Generalise', mode));
  const size = pvNumberInput(existing && Number(existing.size) > 0 ? Number(existing.size) : 10, 0);
  const sizeRow = fieldRow('Bucket size', size);
  body.appendChild(sizeRow);
  const hint = pvMaskHint('');
  body.appendChild(hint);
  const paint = (): void => {
    sizeRow.hidden = mode.value !== 'bucket';
    hint.textContent = mode.value === 'month'
      ? '2024-03-17 becomes 2024-03. Values that are not dates are cleared.'
      : mode.value === 'domain'
        ? 'jane@example.com becomes @example.com. Values that are not email addresses are cleared.'
        : `Each number is rounded down to its bucket: with ${Number(size.value) > 0 ? Number(size.value).toLocaleString() : 10}, 57 becomes ${Number(size.value) > 0 ? Math.floor(57 / Number(size.value)) * Number(size.value) : 50}. The column stays a number column.`;
  };
  mode.addEventListener('change', paint);
  size.addEventListener('input', paint);
  paint();
  return () => {
    const column = need();
    if (!column) return null;
    if (mode.value === 'bucket') {
      const s = Number(size.value);
      if (!(s > 0)) {
        window.alert('Enter a bucket size greater than zero.');
        return null;
      }
      return { type, column, mode: 'bucket', size: s };
    }
    return { type, column, mode: mode.value };
  };
}

/** Open Prepare on a new mask step for `column` — the profile panel's "Mask…" action. */
function pvOpenMaskEditor(column: string): void {
  pvMaskPrefill = column;
  // The profile describes the column as it is NOW; after the step it would be
  // describing values that are no longer there. Close it, as a column change would.
  dsCloseProfile();
  const tab = document.getElementById('ds-tab-prepare');
  if (tab) tab.click();
  openStepEditor('mask_hash', -1);
}
