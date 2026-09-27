// The system prompts whose answer NO module in particular parses.
//
// A prompt and the parser that reads its answer must change together — a prompt
// that drifts from its parser is an unseeable bug — so a prompt with a dedicated
// reader lives WITH that reader, not here: CHAT_SYSTEM_PROMPT in
// ./suggestedAction.ts, DRAFT_DASHBOARD_SYSTEM_PROMPT in
// ../analysis/analysisPlan.ts, and the capture envelope (SYSTEM_PROMPT /
// DEFAULT_PROMPT / FOLLOWUP_FORMAT_HINT) beside parseReply() in ./analyze.ts,
// which validates its answer against the controlled vocabularies spelled out in
// the prompt itself.
//
// What is left is this file: prose with no parser at all, and the three
// STRUCTURE-ONLY proposals whose contract is with a sanitizer in a THIRD module
// (transforms.ts, the visuals IPC, formula.ts) — so no co-location was available
// and analyze.ts was only their storage locker.
//
// One rule they all share, and the reason they are worth guarding: the model
// proposes STRUCTURE and NEVER a computed number. The app does the math.

import { SUGGESTABLE_CHART_TYPES } from '../analysis/visuals';

// Prose out, no parser — the "Explain this dataset" one-shot. The caller builds
// a COMPACT summary containing the app-computed numbers as FACTS; the model only
// narrates and must never invent or recompute a figure.
export const EXPLAIN_SYSTEM_PROMPT =
  'You are a data explainer for Ordinate. You are given a compact summary of a ' +
  'dataset — its columns, their types, already-computed statistics, and a few sample ' +
  'rows. Reply in plain, concise prose (2-5 sentences): describe what the dataset ' +
  'appears to contain, notable patterns, and any data-quality caveats mentioned. ' +
  'Do NOT use markdown, code fences, or bullet lists. NEVER invent, round, or ' +
  'recompute any number — use only the exact figures given to you as facts.';

// Data-preparation steps. The step types and shapes below mirror the sanitiser in
// src/data/transforms.ts — an unknown step is dropped there, so a prompt that
// drifts from that list silently proposes steps that vanish. The model proposes
// STRUCTURE ONLY, referencing the exact column names given; the app's pure
// pipeline does every calculation.
//
// The three MASK steps (mask_hash / mask_redact / mask_generalize) are
// deliberately NOT offered. Deciding what is sensitive is the app's detector's
// job (data/sensitivity.ts) and the user's decision, never the model's — and
// the model is shown sample values of exactly the columns in question. A mask
// step a model volunteered anyway would still reach the user as a suggestion
// they apply or not; it can only ever remove information.
export const SUGGEST_STEPS_SYSTEM_PROMPT =
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
  '  { "type": "split_column", "column": "<col>", "mode": "delimiter|position|regex", "delimiter": "<text>", ' +
  '"positions": [<int>], "pattern": "<regex without lookaround or backreferences>", "into": "columns|rows", "count": <2-50> }\n' +
  '  { "type": "unpivot", "columns": ["<col>"], "attribute": "<new column>", "value": "<new column>" }\n' +
  '  { "type": "pivot", "key": "<col>", "value": "<col>", "fn": "sum|avg|count|min|max", "groupBy": ["<col>"] }\n' +
  '  { "type": "parse_date", "column": "<col>", "format": "YYYY-MM-DD|DD/MM/YYYY|MM/DD/YYYY|DD-MMM-YYYY|DD.MM.YYYY|' +
  'YYYY/MM/DD|YYYYMMDD, optionally followed by \' HH:mm\' or \' HH:mm:ss\'" }\n' +
  '  { "type": "dedupe_key", "columns": ["<col>"], "keep": "first|last|max|min", "by": "<col, for max|min>" }\n' +
  '  { "type": "replace_values", "column": "<col>", "mode": "exact|contains|regex", "rules": [{ "from": "<text>", "to": "<text>" }] }\n' +
  '  { "type": "conditional_column", "name": "<new column>", "rules": [{ "when": { "column": "<col>", ' +
  '"op": "=|!=|>|<|>=|<=|contains|is_empty|not_empty", "value": <optional> }, "then": "<text>" }], "else": "<text>" }\n' +
  '  { "type": "window", "fn": "row_number|lag|lead|running_sum|running_avg", "as": "<new column>", "column": "<col>", ' +
  '"partitionBy": ["<col>"], "orderBy": "<col>" }\n' +
  '  { "type": "union", "datasetId": "<id>" }\n' +
  '  { "type": "lookup_join", "datasetId": "<id>", "leftKey": "<col>", "rightKey": "<col>", "columns": ["<col>"] }\n' +
  '  { "type": "text_terms", "column": "<text col>", "lang": "en|es|fr|de", "minN": <1-3>, "maxN": <1-3>, "top": <1-1000>, ' +
  '"by": "<col optional>", "rank": "count|tfidf (tfidf needs by)" }\n' +
  '  { "type": "text_sentiment", "column": "<text col>", "as": "<new column optional>" }\n' +
  '  { "type": "keyword_rules", "column": "<text col>", "as": "<new column optional>", "rules": [{ "pattern": "<text>", ' +
  '"match": "contains|word|regex", "category": "<text>" }], "otherwise": "<text>" }\n' +
  'Propose union or lookup_join ONLY when another dataset\'s id is given to you; never invent an id.\n' +
  'Return ONLY the JSON array (use [] if no preparation is warranted).';

// Charts. The chart-type whitelist is interpolated from the one list the
// sanitizer also validates against, so the two cannot drift.
//
// `why` is a caption about STRUCTURE ("Revenue summed by region"), which is why
// the no-numbers rule is restated for it specifically — a caption is the one
// field where a model is most tempted to volunteer a figure.
export const SUGGEST_CHARTS_SYSTEM_PROMPT =
  'You propose charts for a tabular dataset as ONLY a JSON ARRAY of objects — no ' +
  'markdown, no code fences, no prose. NEVER output any data value, computed ' +
  'number, figure, percentage or count; the app performs all math itself. ' +
  'Reference ONLY the exact column names given to you — never invent a column. ' +
  'Use this exact shape for each element:\n' +
  '  { "category": "<dimension column>", "values": [{ "column": "<col>", "aggregation": "sum|avg|count|min|max" }], ' +
  '"series": "<optional split column>", "chartType": "<one of the listed chart types>", ' +
  '"why": "<short caption naming ONLY columns and the aggregation, e.g. \\"Revenue summed by region\\">" }\n' +
  '"why" must be under 100 characters and must NOT contain a number. ' +
  'The chart type must be one of: ' + SUGGESTABLE_CHART_TYPES.join(', ') + '.\n' +
  'Propose DIFFERENT views of the data, not the same chart restyled. ' +
  'Return ONLY the JSON array.';

// One calculated field. The function list is a deliberately NARROW subset of
// formulaEval.FUNCTIONS — every name here must really compile (pinned by
// test-prompts.ts); the app evaluates the formula over every row itself, so the
// model must never state a result.
export const SUGGEST_CALC_FIELD_SYSTEM_PROMPT =
  'You propose ONE calculated field for a tabular dataset as ONLY a single JSON object — no markdown, no code ' +
  'fences, no prose. NEVER output a computed data value or number; the app evaluates the formula itself over ' +
  'every row. Reference ONLY the exact column names given to you (bare, or in [brackets] if they contain ' +
  'spaces). Use this exact shape:\n' +
  '  { "name": "<new column name>", "expression": "<formula over the columns>" }\n' +
  'The expression may use + - * / %, comparisons (= != > < >= <=), and/or/not, parentheses, numeric/string ' +
  'literals, and these functions ONLY: round, abs, floor, ceil, min, max, lower, upper, trim, len, concat, ' +
  'if, coalesce. Example: { "name": "Margin", "expression": "([revenue] - [cost]) / [revenue]" }. ' +
  'Return ONLY the JSON object.';
