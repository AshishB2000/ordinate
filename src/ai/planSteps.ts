// The Assistant's PLAN action — its step vocabulary, the shape whitelist a
// model's plan goes through, and the prompt fragment that describes it.
//
// MAIN PROCESS ONLY, and PURE: no fs, no electron, no transforms — this file is
// required by src/ai/suggestedAction.ts, whose own purity lets its test drive
// it in plain node. What a step MEANS (does the dataset exist, does the formula
// compile, is the chart drawable) is decided by src/ai/planCheck.ts with the
// same validators the single actions use; here only the SHAPE is checked.
//
// A plan is an ordered list of steps, each one of the app's EXISTING action
// kinds — import a file (through the file picker), a prepare step, a calculated
// field, a metric, a visual, a dashboard, a style, an alert. The model proposes
// structure and names; it never writes a figure. An alert threshold is the one
// number a step carries, and the prompt only allows a number the USER said.

/** The step kinds, in the order the prompt lists them. */
export const PLAN_STEP_KINDS = ['import', 'step', 'calc', 'metric', 'chart', 'dashboard', 'style', 'alert'] as const;
export type PlanStepKind = typeof PLAN_STEP_KINDS[number];
const KINDS: ReadonlySet<string> = new Set(PLAN_STEP_KINDS);

/** Longest plan the app will run. A request that needs more is two requests. */
export const MAX_PLAN_STEPS = 12;
/** The most JSON a plan line may carry — a dozen steps, each a few names. */
export const MAX_PLAN_CHARS = 12000;
/** The most JSON one nested object (a prepare step, an encoding) may carry. */
const MAX_OBJECT_CHARS = 4000;
const MAX_NAME = 120;
const MAX_EXPRESSION = 2000;
const MAX_REFS = 12;

export interface ImportStep { kind: 'import'; file: string; name: string }
export interface PrepareStep { kind: 'step'; dataset: string; step: Record<string, unknown> }
export interface CalcStep { kind: 'calc'; dataset: string; name: string; expression: string }
export interface MetricStep { kind: 'metric'; dataset: string; name: string; column: string; aggregation: string }
export interface ChartStep {
  kind: 'chart';
  dataset: string;
  name: string;
  chartType: string;
  encoding: Record<string, unknown>;
  filters: unknown[];
}
export interface DashboardStep { kind: 'dashboard'; name: string; visuals: string[]; metrics: string[] }
export interface StyleStep { kind: 'style'; dashboard: string; preset: string }
export interface AlertStep { kind: 'alert'; metric: string; op: string; value: number | null; name: string }

export type PlanStep =
  | ImportStep | PrepareStep | CalcStep | MetricStep | ChartStep | DashboardStep | StyleStep | AlertStep;

function str(v: unknown, max = MAX_NAME): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** A plain object whose JSON fits the bound, or null. */
function boundedObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  let size = Infinity;
  try { size = JSON.stringify(v).length; } catch (_) { /* unserialisable */ }
  return size <= MAX_OBJECT_CHARS ? (v as Record<string, unknown>) : null;
}

function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x)).filter(Boolean).slice(0, MAX_REFS);
}

/**
 * One step, clamped to its kind's shape. Null for anything that is not a step
 * at all (not an object, an unknown kind). A step with a MISSING field survives
 * with it empty: saying "step 3 names no dataset" is planCheck's job, and a
 * plan whose third step silently vanished would run its fourth against the
 * wrong table.
 */
export function sanitizePlanStep(raw: unknown): PlanStep | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = typeof o.kind === 'string' ? o.kind : '';
  if (!KINDS.has(kind)) return null;
  switch (kind as PlanStepKind) {
    case 'import':
      // A file NAME, never a path: the picker opens where the user keeps files
      // and the model only pre-fills what they asked for.
      return { kind: 'import', file: str(o.file).split(/[\\/]/).pop() || '', name: str(o.name) };
    case 'step':
      return { kind: 'step', dataset: str(o.dataset), step: boundedObject(o.step) || {} };
    case 'calc':
      return { kind: 'calc', dataset: str(o.dataset), name: str(o.name), expression: str(o.expression || o.formula, MAX_EXPRESSION) };
    case 'metric':
      return { kind: 'metric', dataset: str(o.dataset), name: str(o.name), column: str(o.column), aggregation: str(o.aggregation, 12) };
    case 'chart':
      return {
        kind: 'chart', dataset: str(o.dataset), name: str(o.name), chartType: str(o.chartType, 40),
        encoding: boundedObject(o.encoding) || {},
        filters: Array.isArray(o.filters) ? o.filters.slice(0, MAX_REFS) : [],
      };
    case 'dashboard':
      return { kind: 'dashboard', name: str(o.name), visuals: names(o.visuals), metrics: names(o.metrics) };
    case 'style':
      return { kind: 'style', dashboard: str(o.dashboard), preset: str(o.preset, 24).toLowerCase() };
    case 'alert':
      return {
        kind: 'alert', metric: str(o.metric), op: str(o.op, 2), name: str(o.name),
        value: typeof o.value === 'number' && Number.isFinite(o.value) ? o.value : null,
      };
  }
  return null;
}

/**
 * The plan off the wire. `dropped` counts entries that were not steps at all,
 * so the card can say so rather than run a shorter plan without a word.
 */
export function sanitizePlanSteps(raw: unknown): { steps: PlanStep[]; dropped: number } {
  if (!Array.isArray(raw)) return { steps: [], dropped: 0 };
  const steps: PlanStep[] = [];
  let dropped = 0;
  for (const item of raw.slice(0, MAX_PLAN_STEPS)) {
    const s = sanitizePlanStep(item);
    if (s) steps.push(s);
    else dropped += 1;
  }
  return { steps, dropped: dropped + Math.max(0, raw.length - MAX_PLAN_STEPS) };
}

/** The icon each kind shows on the card (renderer/hub/icons.ts names). */
export const STEP_ICONS: Record<PlanStepKind, string> = {
  import: 'upload', step: 'filter', calc: 'function', metric: 'gauge',
  chart: 'chart-bar', dashboard: 'layout-dashboard', style: 'sliders', alert: 'bell',
};

/** One app-written line per step. Names are the plan's own; no figure appears. */
export function describeStep(s: PlanStep): string {
  const q = (v: string): string => (v ? `"${v}"` : '(unnamed)');
  switch (s.kind) {
    case 'import': return `Import ${s.file || 'a data file'}${s.name ? ` as ${q(s.name)}` : ''}`;
    case 'step': {
      const t = typeof s.step.type === 'string' ? s.step.type.replace(/_/g, ' ') : 'prepare step';
      const col = typeof s.step.column === 'string' ? ` on ${s.step.column}` : '';
      return `${t.charAt(0).toUpperCase() + t.slice(1)}${col} in ${q(s.dataset)}`;
    }
    case 'calc': return `Add calculated field ${q(s.name)} to ${q(s.dataset)}`;
    case 'metric': return `Define metric ${q(s.name)} — ${s.aggregation || '?'} of ${s.column || '?'} in ${q(s.dataset)}`;
    case 'chart': return `Build ${s.chartType || 'a'} chart ${q(s.name)} from ${q(s.dataset)}`;
    case 'dashboard': {
      const n = s.visuals.length + s.metrics.length;
      return `Assemble dashboard ${q(s.name)} from ${n} tile${n === 1 ? '' : 's'}`;
    }
    case 'style': return `Style ${s.dashboard ? q(s.dashboard) : 'the dashboard'} as ${s.preset || '?'}`;
    case 'alert': return `Alert when ${q(s.metric)} ${s.op || '?'} ${s.value === null ? '?' : String(s.value)}`;
  }
  return 'Step';
}

// The prompt fragment. Appended to the chat prompt by suggestedAction.ts so the
// plan contract and the action contract are read together.
export const PLAN_PROMPT =
  ' Use "plan" when the user asks for SEVERAL things to be built in one go — importing, cleaning, ' +
  'calculating and building ("import sales.csv, clean it, and build me a regional dashboard"). ' +
  'For "plan" ONLY, the line carries ordered steps, all on the same single line:\n' +
  '@@ACTION {"kind":"plan","intent":"<the request, restated>","steps":[<step>,…]}\n' +
  'Each step is exactly one of:\n' +
  '{"kind":"import","file":"<the file name the user named>","name":"<dataset name>"}\n' +
  '{"kind":"step","dataset":"<dataset>","step":{"type":"filter|dedupe|trim|fill_empty|drop_column|rename_column|group_aggregate",…}} ' +
  '(filter: "column","op" (= != > < >= <= contains is_empty not_empty),"value"; dedupe: "columns":[…]; ' +
  'trim/fill_empty/drop_column: "column" (fill_empty also "value"); rename_column: "from","to")\n' +
  '{"kind":"calc","dataset":"<dataset>","name":"<new column>","expression":"<formula over [column] names>"}\n' +
  '{"kind":"metric","dataset":"<dataset>","name":"<metric name>","column":"<column>","aggregation":"sum|avg|count|min|max"}\n' +
  '{"kind":"chart","dataset":"<dataset>","name":"<visual name>","chartType":"<chart type>",' +
  '"encoding":{"category":"<column>","values":[{"column":"<column>","aggregation":"sum|avg|count|min|max"}]}}\n' +
  '{"kind":"dashboard","name":"<dashboard name>","visuals":["<visual name>",…],"metrics":["<metric name>",…]}\n' +
  '{"kind":"style","dashboard":"<dashboard name>","preset":"clean|executive|dense|dark"}\n' +
  '{"kind":"alert","metric":"<metric name>","op":">|<|>=|<=","value":<a number the USER stated>,"name":"<alert name>"}\n' +
  'Later steps refer to what earlier steps create BY THE NAMES YOU GAVE THEM; a dataset imported by a step ' +
  'is named by its "name". Use at most ' + MAX_PLAN_STEPS + ' steps. Name columns exactly as the FACTS list them ' +
  '(for a file not imported yet, use the names the user gave). A plan NEVER contains a computed number, and an ' +
  'alert value is only ever a number the user said — otherwise leave the alert out. When the kind is "plan", ' +
  'your prose is ONE short sentence saying what the plan will build; the app shows the steps.';
