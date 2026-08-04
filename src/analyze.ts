// Analyze a captured image using the configured AI provider.
// Runs in the MAIN PROCESS ONLY — the API key never leaves main.

import { net } from 'electron';
import * as config from './config';
import { runLocalCli } from './localCliRun';
import { computeMetrics, deriveChartData } from './calc';
import { writeHeadline, verifyHeadlineNumbers } from './headline';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Controlled vocabularies for the additive extraction fields (step 1: extract +
// classify only; no math, no display change). The parser validates against these
// and drops anything off-list so later metric code only ever sees known values.
const DATA_SHAPES = ['time_series', 'part_to_whole', 'single_metric', 'categorical', 'unstructured'];
const COLUMN_ROLES = ['category', 'period', 'value', 'total'];
const CALC_VOCAB = [
  'yoy_pct_change', 'total_change', 'acceleration', 'pct_of_total', 'concentration_top_n',
  'rank_by_value', 'rank_by_growth', 'gap_to_average', 'cagr', 'above_below_average',
];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low'];

// Brief system prompt for consistent JSON output across all turns.
const SYSTEM_PROMPT =
  'You are a data analysis assistant for Screenchart. ' +
  'Always respond with ONLY a JSON object — no markdown, no code fences, no text outside the JSON.';

// Full analysis prompt sent with the image on the first turn.
const DEFAULT_PROMPT =
  'Analyze this screenshot and return ONLY a JSON object in this exact shape:\n\n' +
  '{\n' +
  '  "title": "<short 3-6 word title for this capture>",\n' +
  '  "analysis": "<1-4 sentence number-free explanation that FRAMES the data (broad patterns/context), NOT the headline\'s specific standouts>",\n' +
  '  "visualizations": [\n' +
  '    { "type": "<chart type id>", "label": "<human label>", "recommended": true }\n' +
  '  ],\n' +
  '  "followups": ["<question>", "<question>", "<question>"],\n' +
  '  "dataShape": "time_series | part_to_whole | single_metric | categorical | unstructured",\n' +
  '  "extractedTable": {\n' +
  '    "columns": [\n' +
  '      { "id": "<short_id>", "label": "<exact header text>", "role": "category | period | value | total",\n' +
  '        "type": "text | number", "periodOrder": <int, ONLY for period columns, low=earliest> }\n' +
  '    ],\n' +
  '    "rows": [ { "<column id>": <raw value EXACTLY as shown — number for numeric cols, text for category> } ]\n' +
  '  },\n' +
  '  "columnRoles": {\n' +
  '    "category": "<column id that names each row, or null>",\n' +
  '    "periods": ["<period column ids in chronological order>"],\n' +
  '    "total": "<column id of a total/sum column, or null>",\n' +
  '    "primaryValue": "<the main value column id to rank or compare by>"\n' +
  '  },\n' +
  '  "suggestedCalculations": ["<applicable calc id>", "..."],\n' +
  '  "headline": {\n' +
  '    "focus": ["<calc ids, most worth featuring first — a subset of suggestedCalculations>"],\n' +
  '    "angle": "<ONE short, NUMBER-FREE sentence naming the story (no figures, percentages, or counts)>"\n' +
  '  },\n' +
  '  "extractionConfidence": "high | medium | low",\n' +
  '  "extractionNotes": "<brief note if any values were uncertain or obscured, else null>"\n' +
  '}\n\n' +
  'Rules:\n' +
  '- "analysis" is ALWAYS present: a fuller QUALITATIVE explanation, 1-4 sentences (aim for 2-3 by\n' +
  '  default; go shorter, even a single sentence, only if the user\'s rules ask for brevity), that FRAMES the data —\n' +
  '  what it broadly shows, the patterns/trends, and what is interesting about its shape or structure.\n' +
  '  It must be NUMBER-FREE (no specific figures, percentages, or counts) and must COMPLEMENT, not repeat,\n' +
  '  the headline. Give the reader the landscape and why it matters; do NOT call out the same specific\n' +
  '  standouts the headline delivers (which item grew most/least, the top-N share, etc.) and do NOT\n' +
  '  restate headline.angle. Think context and explanation here; the headline lands the specific facts.\n' +
  '- DATA EXTRACTION IS THE FOUNDATION — accuracy here matters most. Read every number EXACTLY as shown\n' +
  '  in the image into extractedTable.rows. Do NOT round, reformat, infer, or compute anything. Strip\n' +
  '  thousands separators and currency symbols to a plain number but keep the exact digits\n' +
  '  (e.g. "$1,234.50" becomes 1234.50, "12%" becomes 12). If a value is blank, use null; never guess.\n' +
  '- extractedTable.columns: one entry per column, with a stable "id", the exact "label", a "role"\n' +
  '  (category | period | value | total), and "type" (text | number). For period columns add\n' +
  '  "periodOrder" (integer, earliest = lowest) so periods are unambiguously ordered.\n' +
  '- Classify "dataShape": time_series (values over ordered periods), part_to_whole (parts summing to a\n' +
  '  whole), single_metric (one headline number), categorical (named categories, no time), or\n' +
  '  unstructured (text/mixed with no clean table).\n' +
  '- Fill "columnRoles" to point at the right column ids: the row-labeling category, the ordered period\n' +
  '  columns, a total column if one exists, and the primaryValue column to rank/compare by.\n' +
  '- PERIOD columns are ONLY for WIDE tables where each period is its OWN column (e.g. a "2024" column\n' +
  '  AND a "2025" column, with one row per entity). For a TIDY/LONG table — where each ROW is a period\n' +
  '  because there is a single "Fiscal year"/"Year"/"Quarter"/"Month"/"Date" column whose CELLS are the\n' +
  '  periods (2025, 2026, …) and the metrics are separate columns — do NOT mark that year column as a\n' +
  '  "period". Make it the "category" (role "category"; it becomes the x-axis labels), give the metric\n' +
  '  columns role "value", set "periods": [], and use dataShape "categorical". The chart must plot the\n' +
  '  METRIC columns across the year rows — never the year numbers themselves as the bars/values.\n' +
  '- "suggestedCalculations": list ONLY the calc ids the data actually supports, most relevant first,\n' +
  '  from this exact set: yoy_pct_change, total_change, acceleration, pct_of_total, concentration_top_n,\n' +
  '  rank_by_value, rank_by_growth, gap_to_average, cagr, above_below_average. Use [] if none apply.\n' +
  '- "headline": pick the 1-3 calc ids most worth LEADING with into "focus" (a subset of\n' +
  '  suggestedCalculations, most important first), and write "angle": ONE short sentence naming the\n' +
  '  story. The angle MUST be number-free — name the pattern (e.g. "Growth is concentrated in a few\n' +
  '  large states while the rest are flat") but state NO figures, percentages, or counts. The app\n' +
  '  computes and inserts the actual numbers; you must never write a number anywhere.\n' +
  '- "extractionConfidence": high if numbers were clear and unambiguous; medium/low if blurry, partially\n' +
  '  obscured, or ambiguous. Put any caveats in "extractionNotes" (or null).\n' +
  '- "visualizations" lists ONLY chart types that genuinely fit this data, MAX 4 chart types PLUS "table".\n' +
  '  Exactly ONE has "recommended": true (the best default). Order best-first.\n' +
  '  Supported type ids (use only these): bar, column, stacked_bar, stacked_column, clustered_bar,\n' +
  '  clustered_column, pct_stacked_bar, pct_stacked_column, line, area, stacked_area, pie, donut, scatter,\n' +
  '  map_bubble, map_choropleth, table\n' +
  '  (bar=horizontal bars, column=vertical bars; pct_stacked=100% stacked; scatter only for x/y numeric pairs;\n' +
  '   map_bubble and map_choropleth ONLY when data is genuinely geographic — countries, states, or lat/lng points)\n' +
  '- If you cannot extract usable data (e.g. a complex dashboard), return an empty extractedTable\n' +
  '  (no rows) and "visualizations": [] — but always include a meaningful "analysis".\n' +
  '- "followups": AT MOST 3 follow-up questions about THIS specific content — surface only your\n' +
  '  best ones; fewer than 3 is fine, never more. Keep each SHORT: a quick tappable phrase\n' +
  '  (about 3-7 words), not a long compound sentence.\n' +
  '- "title": concise, descriptive, 3-6 words. Used as the entry header and sidebar label.\n' +
  '- GEOGRAPHIC DATA ONLY: when data contains countries, US states/counties/cities/ZIPs, or\n' +
  '  lat/lng coordinates, include:\n' +
  '    "geo": {\n' +
  '      "level": "country" | "us_state" | "us_county" | "us_city" | "us_zip" | "point",\n' +
  '      "items": [ { "name": "<place>", "state": "<opt>", "kind": "<opt>", "value": <number>, "lat": <opt>, "lng": <opt> } ]\n' +
  '    }\n' +
  '  Use standard English country names (United States, China…) or full US state names\n' +
  '  (California, New York…). Pick the level that matches the rows:\n' +
  '    • us_county — county-level US data. Each item needs "state" (full name, e.g. "Virginia").\n' +
  '      Virginia independent cities (Newport News, Alexandria, Hampton…) are county-equivalents:\n' +
  '      use us_county for them and set "kind":"city"; use "kind":"county" for counties. When a\n' +
  '      name is both (e.g. Roanoke county and Roanoke city), "kind" disambiguates.\n' +
  '    • us_city — sub-county cities/towns. Each item needs "state". Include lat/lng when known.\n' +
  '    • us_zip — ZIP codes; "name" is the 5-digit code, plus "state". Include lat/lng when known.\n' +
  '    • Drop the "County"/"city" suffix from "name" (use "Stafford", not "Stafford County").\n' +
  '  For "point" level, lat and lng are required. Omit "geo" entirely for non-geographic data.\n' +
  '- Return ONLY the JSON object.';

// Appended to follow-up user messages so the AI maintains the same output format.
const FOLLOWUP_FORMAT_HINT =
  '\n\n[Respond in the same JSON format: {"title":"...","analysis":"...",' +
  '"visualizations":[...],"geo":{...},"followups":[...],"dataShape":"...","extractedTable":{...},' +
  '"columnRoles":{...},"suggestedCalculations":[...],"headline":{"focus":[...],"angle":"..."},' +
  '"extractionConfidence":"...","extractionNotes":...}. ' +
  'Include "geo" only when the data is geographic. ' +
  'Re-fill the extraction fields (extractedTable/dataShape/columnRoles/headline/etc.) only if this ' +
  'answer introduces new tabular or numeric data, extracting numbers exactly; otherwise omit them. ' +
  'Keep "analysis" and "headline.angle" qualitative and NUMBER-FREE (the app inserts the figures). ' +
  'Keep "followups" to AT MOST 3 short, tappable questions (about 3-7 words each). ' +
  'If the question does not require new data, you may return an empty extractedTable and visualizations ' +
  'but always provide a meaningful analysis answering the question.]';

// Typed error constructors — raw provider text / status never reaches the renderer.
type TypedError = { ok: false; errorType: string; message: string; detail?: string };
function errNetwork(): TypedError {
  return { ok: false, errorType: 'network', message: 'No connection — check your internet and try again.' };
}
function errAuth(): TypedError {
  return { ok: false, errorType: 'auth', message: 'Your API key was rejected. Check it in Settings.' };
}
function errNoKey(): TypedError {
  return { ok: false, errorType: 'auth', message: 'No API key saved — add one in Settings.' };
}
function errRateLimit(): TypedError {
  return { ok: false, errorType: 'rate_limit', message: 'Too many requests — wait a moment and try again.' };
}
function errProvider(): TypedError {
  return { ok: false, errorType: 'provider', message: 'The AI provider had an error. Try again.' };
}
function errBadReply(): TypedError {
  return { ok: false, errorType: 'bad_reply', message: "Couldn't read the AI's response. Try again." };
}
// Distinct from errBadReply: the provider hit the max_tokens cap and cut the reply
// off mid-JSON. Retrying the SAME capture won't help — the user must raise the cap.
function errTruncated(): TypedError {
  return { ok: false, errorType: 'truncated', message: 'Response was cut off — try raising Max tokens in Settings.' };
}
function errUnknown(): TypedError {
  return { ok: false, errorType: 'unknown', message: 'Something went wrong. Try again.' };
}

// Heuristic: do the user's global rules ask for a SHORT output? The model already
// shortens the prose analysis directly; this flag also trims the headline (which is
// code-rendered, not prose) to a single featured figure, so "keep it short" governs
// the WHOLE output. Conservative — fires only on clear brevity phrasings.
const BREVITY_RE = /\b(?:concise|brief|briefly|succinct|terse|shorter|one[- ]?sentence|one[- ]?liner|tl;?dr)\b|(?:under|below|less than|no more than|at most|max(?:imum)?)\s+(?:one|two|three|a few|\d+)\s+sentenc/i;
function wantsBrevity(): boolean {
  return BREVITY_RE.test(config.get().globalRules || '');
}

// Parse the raw text reply from the model into a normalized result object.
// ponytail: the result is the model's big JSON envelope plus computed fields —
// typed loosely on purpose.
export function parseReply(raw: string | null | undefined): any {
  let text = (raw || '').trim();
  // Strip accidental markdown code fences.
  text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    return errBadReply();
  }

  if (!parsed || typeof parsed.analysis !== 'string') {
    return errBadReply();
  }

  const visualizations = Array.isArray(parsed.visualizations)
    ? parsed.visualizations.filter((v: any) => v && typeof v.type === 'string')
    : [];
  const followups = Array.isArray(parsed.followups)
    ? parsed.followups.filter((f: any) => typeof f === 'string' && f.trim())
    : [];

  // Geographic data — only include when valid
  let geo: { level: string; items: any[] } | null = null;
  const rawGeo = parsed.geo;
  const GEO_LEVELS = ['country', 'us_state', 'us_county', 'us_city', 'us_zip', 'point'];
  if (rawGeo && typeof rawGeo === 'object' &&
      GEO_LEVELS.includes(rawGeo.level) &&
      Array.isArray(rawGeo.items)) {
    // Items keep name/value plus optional state/kind/lat/lng — the renderer uses
    // state+kind to disambiguate US sub-state regions, lat/lng for bubble fallback.
    const items = rawGeo.items.filter((item: any) =>
      item && typeof item.name === 'string' && item.name.trim() && typeof item.value === 'number'
    );
    if (items.length > 0) {
      geo = { level: rawGeo.level, items };
    }
  }

  // ── Additive structured extraction (step 1) ────────────────────────────────
  // Parsed, validated, stored, and logged — but NOT displayed yet. Every field is
  // optional: older/edge responses that omit them degrade to null/empty cleanly,
  // so existing rendering is unaffected. No math happens here — raw values only.
  const dataShape = DATA_SHAPES.includes(parsed.dataShape) ? parsed.dataShape : null;

  const rawTable = (parsed.extractedTable && typeof parsed.extractedTable === 'object') ? parsed.extractedTable : {};
  const columns = Array.isArray(rawTable.columns)
    ? rawTable.columns
        .filter((c: any) => c && typeof c.id === 'string' && c.id.trim())
        .map((c: any) => {
          const col: { id: string; label: string; role: string | null; type: string | null; periodOrder?: number } = {
            id: c.id,
            label: typeof c.label === 'string' ? c.label : c.id,
            role: COLUMN_ROLES.includes(c.role) ? c.role : null,
            type: (c.type === 'number' || c.type === 'text') ? c.type : null,
          };
          if (Number.isInteger(c.periodOrder)) col.periodOrder = c.periodOrder;
          return col;
        })
    : [];
  // Rows are kept verbatim (objects keyed by column id) — raw values exactly as
  // the model read them; we deliberately do not coerce or compute.
  const rows = Array.isArray(rawTable.rows)
    ? rawTable.rows.filter((r: any) => r && typeof r === 'object' && !Array.isArray(r))
    : [];
  const extractedTable = { columns, rows };

  const rawRoles = (parsed.columnRoles && typeof parsed.columnRoles === 'object') ? parsed.columnRoles : {};
  const columnRoles = {
    category: typeof rawRoles.category === 'string' ? rawRoles.category : null,
    periods: Array.isArray(rawRoles.periods) ? rawRoles.periods.filter((p: any) => typeof p === 'string') : [],
    total: typeof rawRoles.total === 'string' ? rawRoles.total : null,
    primaryValue: typeof rawRoles.primaryValue === 'string' ? rawRoles.primaryValue : null,
  };

  const suggestedCalculations = Array.isArray(parsed.suggestedCalculations)
    ? parsed.suggestedCalculations.filter((c: any) => CALC_VOCAB.includes(c))
    : [];

  const extractionConfidence = CONFIDENCE_LEVELS.includes(parsed.extractionConfidence) ? parsed.extractionConfidence : null;
  const extractionNotes = (typeof parsed.extractionNotes === 'string' && parsed.extractionNotes.trim())
    ? parsed.extractionNotes.trim()
    : null;

  // Chart data is DERIVED IN CODE from extractedTable (the single source of truth) —
  // the AI no longer emits data.series, so every number is read exactly once. Empty
  // or unstructured tables yield { labels: [], series: [] } → the "no chart" path.
  const chartData = deriveChartData(extractedTable, columnRoles, dataShape);

  // ── Step 2: compute metrics from the extracted numbers (our code, no AI) ────
  // The engine independently re-checks applicability, so the AI's suggestion list
  // is only a hint. Returns { selected:[…≤5 shown…], results:{ id: metric } }.
  const metrics = computeMetrics(extractedTable, columnRoles, suggestedCalculations);

  // ── Step 3: headline. The AI provides only a hint (which calcs to feature +
  // a number-free angle); OUR code writes the sentences and injects the verified
  // numbers. Validate the hint against the calc vocab.
  const rawHeadline = (parsed.headline && typeof parsed.headline === 'object') ? parsed.headline : {};
  const headline = {
    focus: Array.isArray(rawHeadline.focus) ? rawHeadline.focus.filter((c: any) => CALC_VOCAB.includes(c)) : [],
    angle: (typeof rawHeadline.angle === 'string' && rawHeadline.angle.trim()) ? rawHeadline.angle.trim() : null,
  };
  // Correctness gate: every figure in the headline must trace to a computed metric.
  // If not, drop the headline rather than surface an unverified number. A brevity
  // global rule caps the headline to its single most important figure (the angle
  // still leads) so the whole output honors "keep it short", not just the analysis.
  let headlineProse = writeHeadline(metrics, headline, wantsBrevity() ? 1 : 3);
  if (headlineProse) {
    const check = verifyHeadlineNumbers(headlineProse);
    if (!check.ok) {
      console.warn('[headline] dropping headline — untraceable figures:', check.stray);
      headlineProse = null;
    }
  }

  // VERIFICATION (dev): dump the extraction + computed metrics to the main-process
  // console so the raw numbers can be compared against the screenshot. Runs in main
  // → shows in the `npm start` terminal. Not shown in the UI. Guarded so it can
  // never break a turn.
  try {
    console.log(`[extract] dataShape=${dataShape} confidence=${extractionConfidence} ` +
      `calcs=[${suggestedCalculations.join(', ') || '-'}]`);
    console.log('[extract] columnRoles:', JSON.stringify(columnRoles));
    console.log('[extract] columns:', JSON.stringify(columns));
    console.log(`[extract] rows (${rows.length}):`, JSON.stringify(rows, null, 2));
    if (extractionNotes) console.log('[extract] notes:', extractionNotes);
    console.log(`[metrics] showing ${metrics.selected.length} of ${Object.keys(metrics.results).length} applicable:`,
      metrics.selected.map(m => m.id).join(', ') || '(none)');
    metrics.selected.forEach(m => console.log(`[metrics]   ${m.id}: ${m.lines.join(' | ')}`));
    console.log('[headline] focus=[%s] angle=%s', headline.focus.join(', ') || '-', headline.angle || '(none)');
    if (headlineProse) console.log('[headline] prose:', headlineProse.plain);
    console.log('[chart] derived from extractedTable:', JSON.stringify(chartData));
  } catch (_) { /* logging must never affect the result */ }

  const result: any = {
    ok: true,
    title: String(parsed.title || '').trim() || 'Analysis',
    analysis: String(parsed.analysis).trim(),
    data: chartData,
    visualizations,
    followups,
    // additive — parsed/stored, not displayed in step 1; the table + metrics ARE
    // displayed as of step 2:
    dataShape,
    extractedTable,
    columnRoles,
    suggestedCalculations,
    extractionConfidence,
    extractionNotes,
    metrics, // { selected: [...≤5], results: {...all applicable} }
    headline, // AI hint: { focus, angle } (record only)
    headlineProse, // code-written { segments, plain, numbers } | null — the displayed headline
  };
  if (geo) result.geo = geo;
  return result;
}

const DEFAULT_MAX_TOKENS = 4096;

// ── Neutral message format ──────────────────────────────────────────────────
// Threads are stored provider-neutral: { role, text, image? } (image = base64 PNG,
// first user turn only). Each adapter translates this into its own wire shape, so
// switching providers mid-thread Just Works. toNeutral() also upgrades any legacy
// Anthropic-format messages persisted before this rework.
type NeutralMsg = { role: string; text: string; image?: string };
function userImageMsg(text: string, base64: string): NeutralMsg { return { role: 'user', text, image: base64 }; }

// ponytail: legacy persisted messages come in several historical shapes — any.
function toNeutral(m: any): NeutralMsg {
  if (m && typeof m.text === 'string') return { role: m.role, text: m.text, image: m.image };
  if (m && Array.isArray(m.content)) {
    let text = '', image;
    for (const b of m.content) {
      if (b.type === 'text') text += b.text || '';
      else if (b.type === 'image' && b.source) image = b.source.data;
    }
    return { role: m.role, text, image };
  }
  if (m && typeof m.content === 'string') return { role: m.role, text: m.content };
  return { role: (m && m.role) || 'user', text: '' };
}
function normalizeThread(msgs: any): NeutralMsg[] { return (msgs || []).map(toNeutral); }

function parseMaxTokens(v: any): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TOKENS;
}

// ── Per-provider request builders (wire shape only; same parser downstream) ──
type BuildArgs = {
  systemPrompt: string;
  messages: NeutralMsg[];
  model: string;
  maxTokens: number;
  apiKey?: string | null;
  baseUrl: string;
};
// ponytail: wire bodies/headers are provider-specific JSON — any.
type WireReq = { url: string; headers: any; body: any };

function buildAnthropic({ systemPrompt, messages, model, maxTokens, apiKey, baseUrl }: BuildArgs): WireReq {
  const toContent = (m: NeutralMsg) => {
    const parts: any[] = [];
    if (m.image) parts.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: m.image } });
    parts.push({ type: 'text', text: m.text || '' });
    return parts;
  };
  return {
    url: `${baseUrl}/v1/messages`,
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: { model, max_tokens: maxTokens, system: systemPrompt, messages: messages.map(m => ({ role: m.role, content: toContent(m) })) },
  };
}
function extractAnthropic(json: any): string { return (json.content && json.content[0] && json.content[0].text) || ''; }
function cutoffAnthropic(json: any): boolean { return !!json && json.stop_reason === 'max_tokens'; }

// OpenAI Chat Completions shape — also used by the OpenAI-compatible gateway.
function buildOpenAI({ systemPrompt, messages, model, maxTokens, apiKey, baseUrl }: BuildArgs): WireReq {
  const toContent = (m: NeutralMsg) => m.image
    ? [{ type: 'text', text: m.text || '' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${m.image}` } }]
    : (m.text || '');
  return {
    url: `${baseUrl}/chat/completions`,
    headers: { authorization: `Bearer ${apiKey || ''}`, 'content-type': 'application/json' },
    body: {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages.map(m => ({ role: m.role, content: toContent(m) }))],
    },
  };
}
function extractOpenAI(json: any): string {
  return (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
}
function cutoffOpenAI(json: any): boolean { return !!json && json.choices && json.choices[0] && json.choices[0].finish_reason === 'length'; }

function buildGemini({ systemPrompt, messages, model, maxTokens, apiKey, baseUrl }: BuildArgs): WireReq {
  const contents = messages.map(m => {
    const parts: any[] = [{ text: m.text || '' }];
    if (m.image) parts.push({ inline_data: { mime_type: 'image/png', data: m.image } });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  return {
    url: `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey || '')}`,
    headers: { 'content-type': 'application/json' },
    body: { system_instruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig: { maxOutputTokens: maxTokens } },
  };
}
function extractGemini(json: any): string {
  const c = json.candidates && json.candidates[0];
  const parts = (c && c.content && c.content.parts) || [];
  return parts.map((p: any) => p.text || '').join('');
}
function cutoffGemini(json: any): boolean { return !!json && json.candidates && json.candidates[0] && json.candidates[0].finishReason === 'MAX_TOKENS'; }

const ADAPTERS: Record<string, { label: string; build: (a: BuildArgs) => WireReq; extract: (json: any) => string; cutoff: (json: any) => boolean }> = {
  anthropic: { label: 'Anthropic API', build: buildAnthropic, extract: extractAnthropic, cutoff: cutoffAnthropic },
  openai:    { label: 'OpenAI API',    build: buildOpenAI,    extract: extractOpenAI,    cutoff: cutoffOpenAI },
  gemini:    { label: 'Gemini API',    build: buildGemini,    extract: extractGemini,    cutoff: cutoffGemini },
  gateway:   { label: 'Gateway',       build: buildOpenAI,    extract: extractOpenAI,    cutoff: cutoffOpenAI },
};

// Shared HTTP call + typed error mapping. opts: { apiKey, baseUrl, model, maxTokens }.
// Returns { rawText } on success or { error: <typed error> } on failure.
type ProviderOpts = { apiKey?: string | null; baseUrl?: string; model: string; maxTokens?: number | string };
type CallResult = { rawText?: string; error?: TypedError };
async function callProvider(provider: string, systemPrompt: string, messages: NeutralMsg[], opts: ProviderOpts): Promise<CallResult> {
  const adapter = ADAPTERS[provider];
  if (!adapter) return { error: errProvider() };

  const baseUrl = (opts.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) return { error: Object.assign(errProvider(), { detail: `${adapter.label} · no base URL set` }) };

  const req = adapter.build({
    systemPrompt, messages,
    model: opts.model,
    maxTokens: parseMaxTokens(opts.maxTokens),
    apiKey: opts.apiKey,
    baseUrl,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await net.fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      // Surface the endpoint's real reason (status + body) — a 404 usually means a
      // wrong model/path, 400 a bad model/request, 401 a bad key. Read the body once,
      // pull the message out of {error:{message}} / {message}, else keep raw text.
      let errCode = '';
      try {
        const text = await res.text();
        try {
          const e = JSON.parse(text);
          const d = (e && e.error) || e;
          errCode = d ? String(d.message || d.type || d.code || d.status || '') : '';
        } catch (_) {
          errCode = (text || '').trim();
        }
      } catch (_) {}
      if (errCode.length > 300) errCode = errCode.slice(0, 300) + '…';
      console.error('[analyze]', adapter.label, 'error', res.status, errCode || '(no detail)');
      const detail = `${adapter.label} · ${res.status}${errCode ? ' · ' + errCode : ''}`;
      if (res.status === 401 || res.status === 403) return { error: Object.assign(errAuth(), { detail }) };
      if (res.status === 429) return { error: Object.assign(errRateLimit(), { detail }) };
      return { error: Object.assign(errProvider(), { detail }) };
    }

    const json = await res.json();
    // Cut off by the token cap → a distinct error, not the generic bad-reply (the
    // truncated body usually fails JSON.parse, so catch it here by stop reason).
    if (adapter.cutoff && adapter.cutoff(json)) {
      console.error('[analyze]', adapter.label, 'response truncated by max_tokens cap');
      return { error: errTruncated() };
    }
    return { rawText: adapter.extract(json) || '' };
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === 'AbortError') { console.error('[analyze] request timed out'); return { error: errNetwork() }; }
    console.error('[analyze] fetch error:', err && err.message);
    return { error: errNetwork() };
  }
}

// Resolve the active BYOK provider + credentials, or return an error.
function resolveByok():
  | { error: TypedError }
  | { error?: undefined; provider: string; apiKey?: string | null; baseUrl?: string; model: string; maxTokens?: number | string } {
  // Only ever run a provider that is actually Connected (verified). A stale or
  // keyless active provider resolves to null → ask the user to connect one.
  const provider = config.effectiveByokActive();
  if (!provider) return { error: errNoKey() };
  const entry = config.getByokProvider(provider); // includes apiKey — main only
  if (provider !== 'gateway' && !entry.apiKey) return { error: errNoKey() };
  if (provider === 'gateway' && !entry.baseUrl) {
    return { error: Object.assign(errProvider(), { detail: 'Gateway · set a base URL in Settings' }) };
  }
  // Gateway/custom can't auto-list models, so there's no safe default — sending a
  // built-in model id (an Anthropic one) to e.g. OpenRouter just 404s. Require the
  // user's own model id instead of silently substituting DEFAULT_MODEL.
  let model = entry.model || (config.BYOK_DEFAULTS[provider] && config.BYOK_DEFAULTS[provider].model) || '';
  if (provider === 'gateway' && !model) {
    return { error: Object.assign(errProvider(), { message: 'Enter a model id for the gateway in Settings (e.g. openai/gpt-4o-mini).' }) };
  }
  if (!model) model = DEFAULT_MODEL;
  return { provider, apiKey: entry.apiKey, baseUrl: entry.baseUrl, model, maxTokens: entry.maxTokens };
}

// MEMORY MODEL — integration point (NOT WIRED YET).
// config.get().memoryModel = { mode: 'same_as_chat' | 'override', provider, model }.
// There is no separate memory/summary AI step in the app today, so nothing consumes
// this. When one is added, route it here: if mode === 'override', call callProvider()
// with that BYOK provider family as the fallback; otherwise reuse dispatch() below.

// Route one request through whichever execution mode is active.
// Returns the shared { rawText } | { error } shape regardless of backend.
// Local CLIs with a working run adapter. Others (retired/install-only) are not
// routable — keep this list in sync with src/localCliRun.js.
const RUNNABLE_LOCAL_CLIS = ['claude', 'antigravity', 'codex', 'grok', 'opencode', 'cursor'];

async function dispatch(systemPrompt: string, messages: NeutralMsg[]): Promise<CallResult> {
  const cfg = config.get();
  if ((cfg.executionMode || 'byok') === 'local') {
    const activeId = cfg.localCli && cfg.localCli.activeId;
    if (!RUNNABLE_LOCAL_CLIS.includes(activeId as string)) {
      return {
        error: activeId
          ? errProvider2('That local CLI isn’t supported yet — pick a runnable local CLI in Execution mode.')
          : errProvider2('No local CLI selected — pick a runnable local CLI in Execution mode.'),
      };
    }
    return runLocalCli(activeId as string, systemPrompt, messages, {});
  }
  const creds = resolveByok();
  if (creds.error) return { error: creds.error };
  return callProvider(creds.provider, systemPrompt, messages, creds);
}

function errProvider2(message: string): TypedError { return { ok: false, errorType: 'provider', message }; }

// Minimal real connectivity test for a provider using its SAVED credentials.
// Returns a typed result: { ok:true, message } or a typed error object.
export async function testProvider(provider: string): Promise<TypedError | { ok: true; message: string }> {
  if (!ADAPTERS[provider]) return errUnknown();
  const entry = config.getByokProvider(provider);
  if (provider !== 'gateway' && !entry.apiKey) return errNoKey();
  if (provider === 'gateway' && !entry.baseUrl) {
    return Object.assign(errProvider(), { message: 'Set a base URL for the gateway.' });
  }
  // Gateway needs the user's own model id — no safe default for an arbitrary endpoint.
  let model = entry.model || (config.BYOK_DEFAULTS[provider] && config.BYOK_DEFAULTS[provider].model) || '';
  if (provider === 'gateway' && !model) {
    return Object.assign(errProvider(), { message: 'Enter a model id for the gateway (e.g. openai/gpt-4o-mini).' });
  }
  if (!model) model = DEFAULT_MODEL;
  const messages = [{ role: 'user', text: 'Reply with the single word OK.' }];
  const { rawText, error } = await callProvider(provider, 'You are a connectivity test. Reply with OK.', messages, {
    apiKey: entry.apiKey, baseUrl: entry.baseUrl, model, maxTokens: '16',
  });
  if (error) return error;
  if (!rawText) return errBadReply();
  return { ok: true, message: 'Connected — the provider responded.' };
}

// Minimal real connectivity test for a local CLI (Claude Code or Antigravity).
// Runs a tiny prompt with no image through the same adapter; typed result.
const LOCAL_CLI_NAMES: Record<string, string> = { claude: 'Claude Code', antigravity: 'Antigravity (Google)', codex: 'Codex CLI', grok: 'Grok CLI', opencode: 'OpenCode', cursor: 'Cursor Agent' };
export async function testLocalCli(cliId: string): Promise<TypedError | { ok: true; message: string }> {
  if (!RUNNABLE_LOCAL_CLIS.includes(cliId)) return errUnknown();
  const messages = [{ role: 'user', text: 'Reply with the single word OK.' }];
  const { rawText, error } = (await runLocalCli(cliId, 'You are a connectivity test. Reply with OK.', messages, {})) as CallResult;
  if (error) return error;
  if (!rawText) return errBadReply();
  return { ok: true, message: `Connected — ${LOCAL_CLI_NAMES[cliId] || 'the CLI'} responded.` };
}

// Plain-prose one-shot through the SAME execution path (BYOK or local CLI) —
// used by the dataset "Explain this dataset" feature. Unlike analyze(), this does
// NOT go through parseReply(): it sends a plain system prompt (no JSON envelope)
// and returns the model's prose verbatim. The caller (dataset:explain) builds a
// COMPACT summary containing the app-computed numbers as FACTS; the model only
// narrates and must never invent or recompute a figure. If no model is configured
// this returns a soft not_ready error so the renderer can show a gentle hint
// rather than an error dialog.
const EXPLAIN_SYSTEM_PROMPT =
  'You are a data explainer for Screenchart. You are given a compact summary of a ' +
  'dataset — its columns, their types, already-computed statistics, and a few sample ' +
  'rows. Reply in plain, concise prose (2-5 sentences): describe what the dataset ' +
  'appears to contain, notable patterns, and any data-quality caveats mentioned. ' +
  'Do NOT use markdown, code fences, or bullet lists. NEVER invent, round, or ' +
  'recompute any number — use only the exact figures given to you as facts.';
export async function explainText(userPrompt: string): Promise<{ ok: true; text: string } | TypedError> {
  if (!config.executionReady()) {
    return { ok: false, errorType: 'not_ready', message: 'Connect a model in Execution settings to explain datasets.' };
  }
  const messages: NeutralMsg[] = [{ role: 'user', text: userPrompt }];
  const { rawText, error } = await dispatch(EXPLAIN_SYSTEM_PROMPT, messages);
  if (error) return error;
  const text = (rawText || '').trim();
  if (!text) return errBadReply();
  return { ok: true, text };
}

// Week 11 — OPTIONAL persistent, context-aware Copilot chat. Same execution path
// as explainText (private dispatch() → BYOK or local CLI); NO new model client.
// The caller (ipc/copilot) builds a FACTS block from app-computed numbers
// (datasetStats / metricValue / vizData) and replays the project's prior chat
// turns. This is a stateless replay like analyzeFollowup: prior turns go verbatim,
// and the FACTS block is re-attached to the CURRENT question every turn (kept as a
// single user turn so provider role-alternation stays valid). Plain prose out — it
// does NOT go through parseReply(). No model configured → a soft not_ready error so
// the renderer shows a gentle hint, never an error dialog.
const CHAT_SYSTEM_PROMPT =
  'You are Screenchart Copilot, a data analysis assistant for the user\'s current workspace. ' +
  'You are given FACTS about the active project/dataset/visual/dashboard — columns, types, ' +
  'already-computed statistics, sample rows, and computed chart/metric values. ' +
  'Answer in plain, concise prose (no markdown, no code fences, no bullet lists unless asked). ' +
  'GROUND every claim in the facts provided. NEVER invent, round, or recompute any number — use ' +
  'ONLY the exact figures given to you; if a number you need is not in the facts, say you don\'t ' +
  'have it rather than estimating. When the data is ambiguous or insufficient to answer, say so ' +
  'plainly. Prefer insight over restating the numbers.';
export async function askCopilot(
  historyTurns: { role: 'user' | 'assistant'; text: string }[],
  contextFacts: string,
  question: string,
): Promise<{ ok: true; text: string } | TypedError> {
  if (!config.executionReady()) {
    return { ok: false, errorType: 'not_ready', message: 'Connect a model in Execution settings to use Copilot.' };
  }
  const prior: NeutralMsg[] = (Array.isArray(historyTurns) ? historyTurns : [])
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string')
    .map((t) => ({ role: t.role, text: t.text }));
  const messages: NeutralMsg[] = [
    ...prior,
    { role: 'user', text: (contextFacts || '') + '\n\n---\n\nQuestion: ' + question },
  ];
  const { rawText, error } = await dispatch(CHAT_SYSTEM_PROMPT, messages);
  if (error) return error;
  const text = (rawText || '').trim();
  return text ? { ok: true, text } : errBadReply();
}

// Week 6 — OPTIONAL AI-suggested data-preparation steps. Same execution path as
// explainText (BYOK or local CLI). The model proposes STRUCTURE ONLY — a JSON
// array of transform steps referencing the exact column names given — and NEVER
// computes or outputs data values (the app's pure pipeline does every calculation,
// preserving the number-accuracy contract). The caller sanitizes the array and the
// renderer requires user confirmation before any step is applied. Returns the raw
// parsed array on success; a soft not_ready error when no model is configured.
const SUGGEST_STEPS_SYSTEM_PROMPT =
  'You propose data-preparation steps for a tabular dataset as ONLY a JSON array — ' +
  'no markdown, no code fences, no prose. NEVER compute or output any data value or ' +
  'computed number; the app performs all math itself. Use ONLY these step types and ' +
  'shapes, and reference ONLY the exact column names given to you:\n' +
  '  { "type": "calculated_field", "name": "<new column>", "expression": "<formula over column names>" }\n' +
  '  { "type": "filter", "column": "<col>", "op": "=|!=|>|<|>=|<=|contains|is_empty|not_empty", "value": <optional> }\n' +
  '  { "type": "group_aggregate", "groupBy": ["<col>"], "aggregations": [{ "column": "<col>", "fn": "sum|avg|count|min|max", "as": "<new column>" }] }\n' +
  '  { "type": "dedupe", "columns": ["<col>"] }\n' +
  '  { "type": "fill_empty", "column": "<col>", "value": <string|number> }\n' +
  '  { "type": "trim", "column": "<col optional>" }\n' +
  '  { "type": "drop_column", "column": "<col>" }\n' +
  '  { "type": "rename_column", "from": "<col>", "to": "<new name>" }\n' +
  'Return ONLY the JSON array (use [] if no preparation is warranted).';
export async function suggestSteps(summaryText: string): Promise<{ ok: true; steps: unknown[] } | TypedError> {
  if (!config.executionReady()) {
    return { ok: false, errorType: 'not_ready', message: 'Connect a model in Execution settings to suggest steps.' };
  }
  const messages: NeutralMsg[] = [{ role: 'user', text: summaryText }];
  const { rawText, error } = await dispatch(SUGGEST_STEPS_SYSTEM_PROMPT, messages);
  if (error) return error;
  let text = (rawText || '').trim();
  // Tolerant parse: strip accidental code fences, then pull out the first JSON
  // array if the model wrapped it in any stray prose.
  text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) { return errBadReply(); }
    } else {
      return errBadReply();
    }
  }
  if (!Array.isArray(parsed)) return errBadReply();
  return { ok: true, steps: parsed };
}

// Week 8 — OPTIONAL AI-suggested chart. Twin of suggestSteps: same execution path
// (BYOK or local CLI), STRUCTURE ONLY, NEVER a data value or computed number. The
// model proposes ONE chart as a single JSON object (a category dimension, one or
// more aggregated measures, an optional split series, and a chart type) that
// references only the given column names. The caller sanitizes it and the renderer
// requires the user to review before saving — the app recomputes every figure.
const SUGGEST_CHART_SYSTEM_PROMPT =
  'You propose ONE chart for a tabular dataset as ONLY a single JSON object — no ' +
  'markdown, no code fences, no prose. NEVER output any data value or computed ' +
  'number; the app performs all math itself. Reference ONLY the exact column names ' +
  'given to you. Use this exact shape:\n' +
  '  { "category": "<dimension column>", "values": [{ "column": "<col>", "aggregation": "sum|avg|count|min|max" }], ' +
  '"series": "<optional split column>", "chartType": "column|bar|line|pie|area|clustered_column|scatter" }\n' +
  'Return ONLY the JSON object.';
export async function suggestChart(
  summaryText: string,
): Promise<{ ok: true; encoding: unknown; chartType: unknown } | TypedError> {
  if (!config.executionReady()) {
    return { ok: false, errorType: 'not_ready', message: 'Connect a model in Execution settings to suggest a chart.' };
  }
  const messages: NeutralMsg[] = [{ role: 'user', text: summaryText }];
  const { rawText, error } = await dispatch(SUGGEST_CHART_SYSTEM_PROMPT, messages);
  if (error) return error;
  let text = (rawText || '').trim();
  // Tolerant parse: strip accidental code fences, then pull out the first JSON
  // object if the model wrapped it in any stray prose.
  text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) { return errBadReply(); }
    } else {
      return errBadReply();
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return errBadReply();
  const o = parsed as Record<string, unknown>;
  // Return the raw encoding-shaped object + chartType; the IPC layer sanitizes both
  // (sanitizeEncoding + sanitizeChartType) before anything reaches disk or a render.
  const encoding = { category: o.category, values: o.values, series: o.series };
  return { ok: true, encoding, chartType: o.chartType };
}

// Week 12 — OPTIONAL AI-suggested calculated field. Twin of suggestChart: same
// execution path (BYOK or local CLI), STRUCTURE ONLY (a single JSON object), and
// NEVER a computed data value or number — the app compiles + evaluates the formula
// over every row itself (src/formula.ts), preserving number-accuracy. The grammar
// below mirrors formula.ts FUNCTIONS exactly so a valid proposal compiles. The IPC
// caller sanitizes/validates and the renderer requires the user to Save the step
// before anything is applied. Soft not_ready when no model is configured.
const SUGGEST_CALC_FIELD_SYSTEM_PROMPT =
  'You propose ONE calculated field for a tabular dataset as ONLY a single JSON object — no markdown, no code ' +
  'fences, no prose. NEVER output a computed data value or number; the app evaluates the formula itself over ' +
  'every row. Reference ONLY the exact column names given to you (bare, or in [brackets] if they contain ' +
  'spaces). Use this exact shape:\n' +
  '  { "name": "<new column name>", "expression": "<formula over the columns>" }\n' +
  'The expression may use + - * / %, comparisons (= != > < >= <=), and/or/not, parentheses, numeric/string ' +
  'literals, and these functions ONLY: round, abs, floor, ceil, min, max, lower, upper, trim, len, concat, ' +
  'if, coalesce. Example: { "name": "Margin", "expression": "([revenue] - [cost]) / [revenue]" }. ' +
  'Return ONLY the JSON object.';
export async function suggestCalcField(
  summaryText: string,
): Promise<{ ok: true; name: unknown; expression: unknown } | TypedError> {
  if (!config.executionReady()) {
    return { ok: false, errorType: 'not_ready', message: 'Connect a model in Execution settings to suggest a calculated field.' };
  }
  const messages: NeutralMsg[] = [{ role: 'user', text: summaryText }];
  const { rawText, error } = await dispatch(SUGGEST_CALC_FIELD_SYSTEM_PROMPT, messages);
  if (error) return error;
  const parsed = parseFirstObject(rawText);
  if (!parsed) return errBadReply();
  return { ok: true, name: parsed.name, expression: parsed.expression };
}

// Week 12 → EXTENDED — the OPTIONAL AI ANALYSIS PLAN. Still the same single model
// call it has always been (same execution path, same tolerant single-object
// parse, same name), but what it asks for grew from a flat card list into the
// PLAN ENVELOPE that src/analysisPlan.ts validates: named sheets of visuals,
// plus calculated fields, plus a rationale.
//
// This function is deliberately NOT twinned with a `draftAnalysis()`. Two AI
// paths that both build an analysis, differing subtly, is the failure mode worth
// avoiding above all others here — so the prompt was extended IN PLACE and the
// old `{name, cards}` shape retired with it.
//
// Unchanged, and the reason the feature is safe: STRUCTURE ONLY. The model names
// datasets, columns, chart types, aggregations and formulas; it NEVER writes a
// value. The caller resolves names→ids, compiles every formula with
// src/formula.ts, validates every encoding against the REAL column types, drops
// and reports what does not survive, and computes every figure itself at render.
//
// `inventoryText` is the app-computed FACTS block (analysisPlan.buildFactsText):
// dataset/column names, declared types and per-column stats — and no rows.
const DRAFT_DASHBOARD_SYSTEM_PROMPT =
  'You propose an ANALYSIS PLAN for a project as ONLY a single JSON object — no markdown, no code fences, no ' +
  'prose. NEVER output a computed value, figure, percentage or count; the app computes every number itself and ' +
  'will REJECT anything it cannot verify. Reference ONLY the exact dataset names, column names, saved-visual ' +
  'names and chart types given to you. Use this shape:\n' +
  '  { "name": "<analysis name>",\n' +
  '    "rationale": "<1-3 sentences, NO numbers, on why these views>",\n' +
  '    "calculatedFields": [ { "dataset":"<dataset name>", "name":"<new column name>", "formula":"<expression>" } ],\n' +
  '    "sheets": [ { "name":"<sheet name>", "visuals": [ <visual>, ... ] } ] }\n' +
  'Aim for 1-3 sheets and 2-5 visuals per sheet. "calculatedFields" may be an empty array.\n' +
  'Each visual is EITHER a new chart:\n' +
  '  { "dataset":"<dataset name>", "name":"<short title>", "chartType":"<one of the listed chart types>",\n' +
  '    "encoding": { "category":"<dimension column>", "values":[ {"column":"<column>",' +
  '"aggregation":"sum|avg|count|min|max"} ], "series":"<optional split column>" },\n' +
  '    "filters": [ {"type":"filter","column":"<column>","op":"=|!=|>|<|>=|<=|contains|is_empty|not_empty",' +
  '"value":<string or number>} ] }\n' +
  'OR a reference to an existing saved visual, to place it as-is:\n' +
  '  { "visual":"<saved visual name>" }\n' +
  'Rules: a measure using sum/avg/min/max MUST name a number column — "count" works on any column. A ' +
  'calculated-field formula may use + - * / %, comparisons (= != > < >= <=), and/or/not, parentheses, ' +
  'numeric/string literals, and functions such as round, abs, floor, ceil, min, max, lower, upper, trim, len, ' +
  'concat, if, coalesce; reference columns bare, or in [brackets] if they contain spaces. ALWAYS wrap a ' +
  'division in round(..., 4) — the app stores a value with more than 15 significant digits as TEXT, so an ' +
  'unrounded ratio produces a column you cannot then average. Do NOT specify positions or sizes — the app ' +
  'arranges the grid. Return ONLY the JSON object.';
export async function draftDashboard(
  inventoryText: string,
): Promise<{ ok: true; structure: unknown } | TypedError> {
  if (!config.executionReady()) {
    return { ok: false, errorType: 'not_ready', message: 'Connect a model in Execution settings to draft an analysis.' };
  }
  const messages: NeutralMsg[] = [{ role: 'user', text: inventoryText }];
  const { rawText, error } = await dispatch(DRAFT_DASHBOARD_SYSTEM_PROMPT, messages);
  if (error) return error;
  const parsed = parseFirstObject(rawText);
  if (!parsed) return errBadReply();
  return { ok: true, structure: parsed };
}

// Week 12 — OPTIONAL prose narration of a dashboard / of detected anomalies. Twins
// of explainText: both delegate to narrate() (its exact body — guard → single user
// turn → dispatch → trimmed prose | errBadReply). The caller (ipc/dashboards) builds
// the FACTS block from app-computed numbers (copilot.dashboardFacts /
// anomalies.buildAnomaliesFacts); the model only narrates and never recomputes.
const SUMMARY_SYSTEM_PROMPT =
  'You are an executive-summary writer for Screenchart. You are given the APP-COMPUTED metric and chart values ' +
  'of a dashboard as FACTS. Write a short executive summary (2-5 sentences) of what the dashboard shows — the ' +
  'headline story, standouts, and any risk/concentration worth flagging. Plain prose, no markdown/bullets. ' +
  'NEVER invent, round, or recompute a figure — cite ONLY the exact numbers given; if a number is not in the ' +
  'facts, do not state one.';
const ANOMALY_SYSTEM_PROMPT =
  'You explain data anomalies for Screenchart. You are given anomalies the APP already detected, each with its ' +
  'app-computed figures, as FACTS. In plain prose (2-5 sentences, no markdown/bullets) explain what these ' +
  'anomalies likely mean and what to check — CONTEXTUALIZE them, do not list them mechanically. NEVER invent, ' +
  'round, or recompute a figure; the app found and measured every anomaly — cite its numbers exactly.';

// Shared prose one-shot (the exact body of explainText, parameterized by prompt +
// a caller-supplied not_ready message so each action names itself in the hint).
async function narrate(systemPrompt: string, factsText: string, notReadyMessage: string): Promise<{ ok: true; text: string } | TypedError> {
  if (!config.executionReady()) {
    return { ok: false, errorType: 'not_ready', message: notReadyMessage };
  }
  const messages: NeutralMsg[] = [{ role: 'user', text: factsText }];
  const { rawText, error } = await dispatch(systemPrompt, messages);
  if (error) return error;
  const text = (rawText || '').trim();
  if (!text) return errBadReply();
  return { ok: true, text };
}
export async function summarizeDashboard(factsText: string): Promise<{ ok: true; text: string } | TypedError> {
  return narrate(SUMMARY_SYSTEM_PROMPT, factsText, 'Connect a model in Execution settings to summarize the dashboard.');
}
export async function explainAnomalies(factsText: string): Promise<{ ok: true; text: string } | TypedError> {
  return narrate(ANOMALY_SYSTEM_PROMPT, factsText, 'Connect a model in Execution settings to explain anomalies.');
}

// Tolerant single-object parse shared by the Week 12 structure wrappers: strip
// accidental code fences, then slice the first {…last } if the whole text is not
// clean JSON. Returns the parsed object or null (an array / non-object → null).
function parseFirstObject(rawText: string | undefined): Record<string, unknown> | null {
  let text = (rawText || '').trim();
  text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
    } else {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

// Combine the always-on envelope system prompt with the user's optional global
// rules (config.globalRules). ADDITIVE: SYSTEM_PROMPT is sent UNCHANGED and the
// rules are appended in a clearly-labeled section that explicitly defers to the
// output format — so a user rule like "reply in plain prose" can't break the
// JSON the app parses. globalRules is pure instruction text: it reaches the model
// only via stdin / a single argv element / the API body (never a shell command).
// Used by every path (BYOK + local CLIs) and every turn (initial + follow-up).
export function buildSystemPrompt(): string {
  const rules = (config.get().globalRules || '').trim();
  if (!rules) return SYSTEM_PROMPT;
  return SYSTEM_PROMPT +
    "\n\n--- User's global rules (PRIORITY — apply these) ---\n" +
    'Follow the user\'s global rules below as closely as possible — including rules about LENGTH ' +
    '(e.g. "under 2 sentences"), TONE/STYLE (formal, casual, British spelling), and CONTENT/EMPHASIS ' +
    '(e.g. "flag any risks", "focus on trends", "note anomalies"). Honor them in your "analysis" and "headline.angle".\n' +
    'The ONLY things a user rule may NOT override:\n' +
    '(a) the JSON structure and field names must stay valid; and\n' +
    '(b) you must NEVER write computed numbers yourself in "analysis" or "headline.angle" — the app ' +
    'computes and inserts every figure. If a rule would have you state a specific number, express the ' +
    'point QUALITATIVELY instead (e.g. "growth is highly concentrated", not "the top 3 hold 60%").\n\n' +
    "User's rules:\n" + rules;
}

// Main entry point — called from main.js for a new capture.
// Returns a result object. On success, also attaches _messages (the thread seed)
// which MUST be stripped by main.js before sending to the renderer.
export async function analyze(dataUrl: string): Promise<any> {
  try {
    const base64 = dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
    const messages = [userImageMsg(DEFAULT_PROMPT, base64)];

    const { rawText, error } = await dispatch(buildSystemPrompt(), messages);
    if (error) return error;

    const result = parseReply(rawText);
    if (result.ok) {
      // Neutral thread stored by main.js; never sent to renderer.
      result._messages = [...messages, { role: 'assistant', text: rawText }];
    }
    return result;
  } catch (err: any) {
    console.error('[analyze] unexpected error:', err && err.message);
    return errUnknown();
  }
}

// Follow-up call — appends userText to existingMessages and calls the AI.
// existingMessages: the full Anthropic messages array stored in main.js.
// Returns same shape as analyze(), including _messages with the updated thread.
export async function analyzeFollowup(existingMessages: any, userText: string): Promise<any> {
  try {
    // normalizeThread upgrades any legacy Anthropic-format messages to neutral.
    const newMessages = [
      ...normalizeThread(existingMessages),
      { role: 'user', text: userText + FOLLOWUP_FORMAT_HINT },
    ];

    const { rawText, error } = await dispatch(buildSystemPrompt(), newMessages);
    if (error) return error;

    const result = parseReply(rawText);
    if (result.ok) {
      result._messages = [...newMessages, { role: 'assistant', text: rawText }];
    }
    return result;
  } catch (err: any) {
    console.error('[analyze] followup error:', err && err.message);
    return errUnknown();
  }
}
