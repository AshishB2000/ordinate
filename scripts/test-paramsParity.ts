'use strict';

// Parity: renderer/hub/dashParams.ts `paramSubst` replaces `{{name}}` exactly
// as src/analysis/params.ts `substituteText` does.
//
// The renderer keeps a copy because a card title is drawn synchronously and a
// classic <script> cannot import a CommonJS module; a copy is only safe while
// something fails when the two drift. dashParams.js runs in a vm here, the way
// scripts/test-periodLabels.ts runs periodPicker.js.
//
//   npm run build:ts && node scripts/test-paramsParity.js

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { paramValues, substituteText } from '../src/analysis/params';

import { ok, finish } from './selfcheck';

const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub', 'dashParams.js'), 'utf8');
const ctx = vm.createContext({});
vm.runInContext(code, ctx);

const entries = [
  { name: 'threshold', kind: 'number', value: 2000 },
  { name: 'Ratio', kind: 'number', value: 0.123456789 },
  { name: 'region', kind: 'text', value: 'West' },
  { name: 'regions', kind: 'list', value: ['West', 'East'] },
  { name: 'none', kind: 'list', value: [] },
  { name: 'asof', kind: 'date', value: '2024-06-30' },
  { name: 'unset', kind: 'text', value: null },
];
const values = paramValues(entries);

const texts = [
  'Orders over {{threshold}}',
  '{{ratio}} and {{ RATIO }}',
  '{{region}} vs {{regions}} ({{none}})',
  'as of {{asof}}; {{unset}}',
  'broken {{nobody}} stays',
  'no braces at all',
  '{{threshold}}{{threshold}}',
  '{ {threshold} } and {{thres hold}}',
  '',
];
for (const t of texts) {
  const main = substituteText(t, values);
  const renderer = vm.runInContext(`paramSubst(${JSON.stringify(t)}, ${JSON.stringify(entries)})`, ctx);
  ok(`"${t}" → "${main}"`, renderer === main, `renderer said "${renderer}"`);
}

finish();
