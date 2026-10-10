// A subscription's message: the composer (src/analysis/subscriptionMessage.ts)
// and both renderers (src/analysis/subscriptionRender.ts) — pure.
//
//   compose    a KPI's change with its direction and whether that is good; a
//              categorical visual's top rows with shares (none when a value is
//              negative); a time series' latest / change / range; a table's
//              first rows; a hidden or failed card says why
//   clean      one bounded line: newlines, control and direction-override
//              characters out
//   Slack      at most 50 blocks, 3,000 characters a text, 10 fields a section
//              of 2,000 each, a 150-character header — on a model far past all
//              of them, with "+N more in the dashboard" and a note for the UI
//   Teams      the Workflows envelope, exactly; under the byte limit on the
//              same oversized model, cut rows before sections
//   escaping   `<!channel>`, `<@U123>`, a Slack link, a Markdown link, `@here`
//              arrive as text. NEGATIVE CONTROL: the detector that proves it
//              fires on the same payload with the escape undone
//   links      the only URL in either payload is the one the server passed in
//
//   npm run build:ts && node scripts/test-subscriptionMessage.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const M: typeof import('../src/analysis/subscriptionMessage') = require('../src/analysis/subscriptionMessage');
const R: typeof import('../src/analysis/subscriptionRender') = require('../src/analysis/subscriptionRender');
type KpiFigure = import('../src/analysis/subscriptionMessage').KpiFigure;
type VisualFigure = import('../src/analysis/subscriptionMessage').VisualFigure;
type Model = import('../src/analysis/subscriptionMessage').MessageModel;

const LINK = 'https://bi.example.com/analyses/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
const compose = (kpis: KpiFigure[], visuals: VisualFigure[], extra: Partial<import('../src/analysis/subscriptionMessage').ComposeInput> = {}): Model =>
  M.composeMessage({ title: 'Weekly sales', subtitle: ['Oct 12, 2026', 'Filtered: Region = North'], kpis, visuals, link: LINK, footer: 'Sent by Ordinate · Weekly sales · Every day at 08:00 (UTC)', ...extra });

// ── KPIs ────────────────────────────────────────────────────────────────────
const cmp = (delta: number, pct: number | null, direction?: 'up_good' | 'down_good', deltaDisplay?: string) => ({ delta, pct, label: 'vs previous period', ...(direction ? { direction } : {}), ...(deltaDisplay ? { deltaDisplay } : {}) });
const k = compose([
  { label: 'Revenue', display: '$5.2M', compare: cmp(214000, 4.29, 'up_good') },
  { label: 'Churn', display: '3.1%', compare: cmp(0.4, 14.8, 'down_good') },
  { label: 'Orders', display: '1,204', compare: cmp(-80, -6.2) },
  { label: 'Flat', display: '10', compare: cmp(0, 0, 'up_good') },
  { label: 'Margin', display: '13.2%', compare: cmp(0.012, null, 'up_good', '+1.2 pts') },
  { label: 'Plain', display: '42' },
  { label: 'Live KPI', display: '—', error: 'The warehouse did not answer in time.' },
], []).kpis;
ok('KPI: up, and up is good → ▲, signed percent, "good"', k[0].value === '$5.2M' && k[0].change === '▲ +4.3% vs previous period · good' && k[0].tone === 'good', JSON.stringify(k[0]));
ok('KPI: up, and DOWN is good → "bad"', k[1].change === '▲ +14.8% vs previous period · bad' && k[1].tone === 'bad', JSON.stringify(k[1]));
ok('KPI: a plain column has no "good" direction — the change is stated, not judged', k[2].change === '▼ −6.2% vs previous period' && k[2].tone === undefined, JSON.stringify(k[2]));
ok('KPI: no change is neither good nor bad', k[3].change === '■ 0% vs previous period' && k[3].tone === undefined, JSON.stringify(k[3]));
ok('KPI: a percent metric\'s change is in points, as the card shows it', k[4].change === '▲ +1.2 pts vs previous period · good', JSON.stringify(k[4]));
ok('KPI: no Compare on the card → just the figure', k[5].value === '42' && k[5].change === undefined);
ok('KPI: one that could not be computed says why, and never shows a figure', k[6].value === 'The warehouse did not answer in time.' && k[6].change === undefined);

// ── visuals as text ─────────────────────────────────────────────────────────
const cat = compose([], [{
  title: 'Sales by region', chartType: 'bar', caption: 'West leads with 400.',
  data: { labels: ['North', 'South', 'East', 'West', 'Nowhere'], series: [{ name: 'sum of amount', values: [100, 300, 200, 400, null] }, { name: 'last year', values: [1, 1, 1, 1, 1], role: 'overlay' }] },
}]).sections[0];
ok('categorical: the biggest first, nulls last', cat.rows.map((r) => r[0]).join() === 'West,South,East,North,Nowhere', JSON.stringify(cat.rows));
ok('categorical: each row carries its value and its share of the total (which adds to 100%)', cat.columns.join('|') === '|sum of amount|Share of total'
  && cat.rows[0].join('|') === 'West|400|40%' && cat.rows[3].join('|') === 'North|100|10%' && cat.rows[4].join('|') === 'Nowhere|—|—', JSON.stringify(cat));
ok('categorical: the app\'s own sentence rides along; an overlay series is not a figure of the chart', cat.caption === 'West leads with 400.' && cat.columns.length === 3);
const neg = compose([], [{ title: 'Profit', chartType: 'column', data: { labels: ['A', 'B'], series: [{ name: 'profit', values: [50, -20] }] } }]).sections[0];
ok('categorical: a negative value → no share column (a share of that total means nothing)', neg.columns.length === 2 && neg.rows[0].join('|') === 'A|50' && neg.rows[1].join('|') === 'B|-20', JSON.stringify(neg));
const many = compose([], [{ title: 'Long', chartType: 'bar', data: { labels: Array.from({ length: 37 }, (_, i) => `c${i}`), series: [{ name: 'n', values: Array.from({ length: 37 }, (_, i) => i) }] } }]).sections[0];
ok(`categorical: the top ${M.TOP_ROWS}, the rest counted`, many.rows.length === M.TOP_ROWS && many.more === 27 && many.rows[0][0] === 'c36');

const ts = compose([], [{
  title: 'Monthly revenue', chartType: 'line',
  data: { dataShape: 'time_series', labels: ['2026-06', '2026-07', '2026-08', '2026-09'], series: [{ name: 'revenue', values: [80, 120, 100, 125] }] },
}]).sections[0];
ok('time series: the latest value (and its point), the change from the point before, the range',
  ts.rows.map((r) => r.join('|')).join(' ; ') === 'Latest value (2026-09)|125 ; Change from the previous point|+25 (+25%) ; Range over the period|80 – 125', JSON.stringify(ts.rows));
const tsGap = compose([], [{ title: 'T', chartType: 'line', data: { dataShape: 'time_series', labels: ['a', 'b', 'c'], series: [{ name: 'x', values: [10, 8, null] }] } }]).sections[0];
ok('time series: a trailing empty point is not the latest; a fall is signed with a real minus', tsGap.rows[0].join('|') === 'Latest value (b)|8' && tsGap.rows[1][1] === '−2 (−20%)', JSON.stringify(tsGap.rows));

const table = compose([], [{
  title: 'Accounts', chartType: 'table',
  data: { labels: Array.from({ length: 14 }, (_, i) => `acct ${i}`), series: [{ name: 'orders', values: Array.from({ length: 14 }, (_, i) => 14 - i) }, { name: 'revenue', values: Array.from({ length: 14 }, (_, i) => i * 1000) }] },
}]).sections[0];
ok('table: the FIRST rows as drawn (not re-sorted), every measure a column, the rest counted',
  table.columns.join('|') === '|orders|revenue' && table.rows[0].join('|') === 'acct 0|14|0' && table.rows.length === M.TOP_ROWS && table.more === 4, JSON.stringify(table.rows[0]));
const hidden = compose([], [{ title: 'Salaries', chartType: 'bar', note: 'Hidden by the share policy' }, { title: 'Broken', chartType: 'bar' }]).sections;
ok('a card the Share policy hid says so and sends no rows; one that failed says it could not be computed',
  hidden[0].rows.length === 0 && hidden[0].note === 'Hidden by the share policy' && hidden[1].note === 'This card could not be computed.', JSON.stringify(hidden));

// ── clean ───────────────────────────────────────────────────────────────────
ok('clean: newlines and tabs collapse to one space (a value cannot forge a second line)', M.clean('North\n*Revenue*  $0\tend') === 'North *Revenue* $0 end');
ok('clean: control, zero-width and direction-override characters are removed', M.clean('a‮gnp.exe​b\u0007c') === 'a gnp.exe b c');
ok('clean: bounded, with an ellipsis', M.clean('x'.repeat(500)).length === 120 && M.clean('x'.repeat(500)).endsWith('…'));
ok('figures hash input: the same figures under another date line are the same; a changed figure is not',
  M.figuresOf(compose([{ label: 'A', display: '1' }], [])) === M.figuresOf(compose([{ label: 'A', display: '1' }], [], { subtitle: ['another day'] }))
  && M.figuresOf(compose([{ label: 'A', display: '1' }], [])) !== M.figuresOf(compose([{ label: 'A', display: '2' }], [])));

// ── a sample message, both platforms ────────────────────────────────────────
const sample = compose(
  [{ label: 'Revenue', display: '$5.2M', compare: cmp(214000, 4.29, 'up_good') }, { label: 'Orders', display: '1,204', compare: cmp(-80, -6.2) }],
  [{ title: 'Sales by region', chartType: 'bar', caption: 'West leads with 400.', data: { labels: ['North', 'South', 'East', 'West'], series: [{ name: 'sum of amount', values: [100, 300, 200, 400] }] } }],
  { note: 'Numbers for the Monday review.' },
);
const slack = R.renderSlack(sample);
const teams = R.renderTeams(sample);
if (process.env.PRINT_SAMPLE) console.log(JSON.stringify(slack.payload, null, 2) + '\n' + JSON.stringify(teams.payload, null, 2));
ok('Slack: header, context, note, KPI fields, one section per visual, the button, the footer — in that order',
  slack.payload.blocks.map((b) => b.type).join() === 'header,context,section,section,section,actions,context', slack.payload.blocks.map((b) => b.type).join());
ok('Slack: nothing was cut, so no note for the UI', slack.notes.length === 0 && slack.model.more === 0);
const env = teams.payload;
ok('Teams: the Workflows envelope — a message with one adaptive-card attachment',
  env.type === 'message' && env.attachments.length === 1 && env.attachments[0].contentType === 'application/vnd.microsoft.card.adaptive'
  && env.attachments[0].content.type === 'AdaptiveCard' && env.attachments[0].content.version === '1.4' && Object.keys(env).sort().join() === 'attachments,type');
ok('Teams: the link is an Action.OpenUrl button', JSON.stringify(env.attachments[0].content.actions) === JSON.stringify([{ type: 'Action.OpenUrl', title: 'Open in Ordinate', url: LINK }]));
ok('Teams: `bytes` is the size of what is sent', teams.bytes === Buffer.byteLength(JSON.stringify(teams.payload)) && teams.notes.length === 0);

/** Every string value in a payload, with the key path it sits at. */
function strings(v: unknown, at = '', out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof v === 'string') out.push([at, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${at}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [key, x] of Object.entries(v)) strings(x, `${at}.${key}`, out);
  return out;
}
const urlsIn = (payload: unknown): string[] => strings(payload).filter(([at, s]) => /\.url$/.test(at) || (/^https?:\/\//.test(s) && !/\$schema$/.test(at))).map(([, s]) => s);
ok('links: the only URL in the Slack payload is the server\'s', urlsIn(slack.payload).join() === LINK, urlsIn(slack.payload).join());
ok('links: the only URL in the Teams payload is the server\'s', urlsIn(teams.payload).join() === LINK, urlsIn(teams.payload).join());
const noLink = compose([{ label: 'A', display: '1' }], [], { link: null });
ok('links: no public address → no button on either platform', !R.renderSlack(noLink).payload.blocks.some((b) => b.type === 'actions') && R.renderTeams(noLink).payload.attachments[0].content.actions === undefined);

// ── escaping ────────────────────────────────────────────────────────────────
const EVIL = ['<!channel> wake up', '<@U123ABC> look', '<https://evil.example/login|Sign in to Ordinate>', '[Sign in](https://evil.example/login)', '@here now', '@everyone', 'a & b <b>bold</b>'];
const evil = compose(
  [{ label: EVIL[0], display: EVIL[1] }],
  [{ title: EVIL[2], chartType: 'bar', caption: EVIL[3], data: { labels: EVIL, series: [{ name: EVIL[4], values: EVIL.map((_, i) => i + 1) }] } }],
  { title: EVIL[0], note: EVIL[2] + ' ' + EVIL[5], subtitle: [EVIL[1]], footer: EVIL[2] },
);

/** What Slack would act on in a text: a special mention, a user mention, a link with a label, a bare broadcast word. */
const slackActive = (payload: unknown): string[] =>
  strings(payload).filter(([at]) => /\.text$/.test(at)).map(([, s]) => s).filter((s) => /<!\w+|<@\w+|<https?:[^>]*\|/.test(s) || /@(channel|here|everyone)\b/.test(s));
const evilSlack = R.renderSlack(evil).payload;
ok('Slack: no text can ping a channel, mention a person or pass as a labelled link', slackActive(evilSlack).length === 0, slackActive(evilSlack).slice(0, 2).join(' || '));
ok('Slack: the values still arrive, as text', JSON.stringify(evilSlack).includes('&lt;!channel&gt; wake up') && JSON.stringify(evilSlack).includes('&lt;@U123ABC&gt;') && JSON.stringify(evilSlack).includes('a &amp; b'));
ok('Slack: the header is plain_text — look-alike brackets, no entity shown as typed', evilSlack.blocks[0].type === 'header' && (evilSlack.blocks[0] as { text: { text: string } }).text.text === '‹!channel› wake up');
const undone = JSON.parse(JSON.stringify(evilSlack).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/​/g, ''));
ok('NEGATIVE CONTROL: with the escape undone the same detector fires — on the ping, the mention, the link and @here',
  ['<!channel', '<@U123ABC', '<https://evil.example/login|', '@here'].every((needle) => slackActive(undone).some((s) => s.includes(needle))), String(slackActive(undone).length));
ok('NEGATIVE CONTROL: slackEscape is what does it', EVIL.slice(0, 3).every((s) => /<[!@h]/.test(s) && !/<[!@h]/.test(R.slackEscape(s))) && R.slackEscape('@here') !== '@here' && R.slackEscape('user@here.example') === 'user@​here.example');

/** Teams reads Markdown in a TextBlock and a FactSet; a TextRun is literal. Every text of the card with the element type that holds it. */
function teamsTexts(v: unknown, holder = '', out: Array<[string, string]> = []): Array<[string, string]> {
  if (Array.isArray(v)) v.forEach((x) => teamsTexts(x, holder, out));
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type : holder;
    for (const [key, x] of Object.entries(o)) {
      if (typeof x === 'string' && ['text', 'title', 'value', 'altText', 'fallbackText'].includes(key)) out.push([type, x]);
      else teamsTexts(x, type, out);
    }
  }
  return out;
}
const markdownRead = (card: unknown): string[] => teamsTexts(card).filter(([type]) => type !== 'TextRun' && type !== 'Action.OpenUrl').map(([type, s]) => `${type}: ${s}`);
const evilTeams = R.renderTeams(evil).payload.attachments[0].content;
ok('Teams: every text is a literal TextRun — nothing is in an element that reads Markdown', markdownRead(evilTeams).length === 0, markdownRead(evilTeams).slice(0, 2).join(' || '));
ok('Teams: the values arrive unchanged, as text', teamsTexts(evilTeams).some(([type, s]) => type === 'TextRun' && s === '[Sign in](https://evil.example/login)'));
ok('Teams: no text run is empty (a blank heading cell is a no-break space)', teamsTexts(teams.payload).every(([, t]) => t.length > 0) && teamsTexts(evilTeams).every(([, t]) => t.length > 0));
ok('Teams: the card declares no mention entities, so no text can be one', !JSON.stringify(evilTeams).includes('"entities"') && !JSON.stringify(evilTeams).includes('<at>'));
ok('Teams: the only action is the server\'s link', JSON.stringify(evilTeams.actions) === JSON.stringify([{ type: 'Action.OpenUrl', title: 'Open in Ordinate', url: LINK }]));
ok('NEGATIVE CONTROL: the same detector flags a card that puts the value in a TextBlock',
  markdownRead({ type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: EVIL[3] }] }).join() === 'TextBlock: [Sign in](https://evil.example/login)');

// ── limits ──────────────────────────────────────────────────────────────────
// Labels full of `&`: each becomes a five-character entity in Slack, so a row that fits as typed does not fit as sent.
const wide = (i: number): VisualFigure => ({
  title: `Section ${i} ` + 'x'.repeat(80), chartType: 'table', caption: 'c'.repeat(380),
  data: { labels: Array.from({ length: 40 }, (_, r) => `row ${r} ` + '&'.repeat(70)), series: Array.from({ length: 60 }, (_, c) => ({ name: `measure ${c}`, values: Array.from({ length: 40 }, (_, r) => r * 1000 + c) })) },
});
const wideSection = compose([], [wide(0)]).sections[0];
ok(`table: at most ${M.TABLE_COLS} measure columns, and the rest are said rather than dropped silently`,
  wideSection.columns.length === 1 + M.TABLE_COLS && wideSection.rows[0].length === 1 + M.TABLE_COLS && wideSection.note === '+55 more columns in the dashboard', JSON.stringify([wideSection.columns.length, wideSection.note]));
const huge = compose(Array.from({ length: 45 }, (_, i) => ({ label: `KPI ${i}`, display: String(i), compare: cmp(1, 1) })), Array.from({ length: 120 }, (_, i) => wide(i)), { title: 'T'.repeat(400), note: 'n'.repeat(5000) });
const bigSlack = R.renderSlack(huge);
const sText = strings(bigSlack.payload.blocks).filter(([at]) => /\.text$/.test(at));
ok(`Slack limits: ${bigSlack.payload.blocks.length} blocks ≤ ${R.SLACK_MAX_BLOCKS}`, bigSlack.payload.blocks.length <= R.SLACK_MAX_BLOCKS && bigSlack.payload.blocks.length > 30);
ok(`Slack limits: no text over ${R.SLACK_MAX_TEXT} characters (longest ${Math.max(...sText.map(([, s]) => s.length))})`, sText.every(([, s]) => s.length <= R.SLACK_MAX_TEXT));
ok('Slack limits: a header is at most 150 characters; a section has at most 10 fields of at most 2,000',
  (bigSlack.payload.blocks[0] as { text: { text: string } }).text.text.length <= 150
  && bigSlack.payload.blocks.every((b) => b.type !== 'section' || !b.fields || (b.fields.length <= 10 && b.fields.every((f) => f.text.length <= 2000))));
ok('Slack limits: what was cut is said — "+N more in the dashboard" for the 25 KPIs and 90 sections left out, and a note for the UI',
  bigSlack.model.more === 25 + 90 && JSON.stringify(bigSlack.payload).includes('+115 more in the dashboard') && bigSlack.notes.length === 1 && /Slack/.test(bigSlack.notes[0]), String(bigSlack.model.more));
const firstSection = bigSlack.model.sections[0];
ok('Slack limits: a section too long for one text loses ROWS, keeps its title and sentence, and counts them',
  firstSection.rows.length < M.TOP_ROWS && firstSection.more === 40 - firstSection.rows.length && JSON.stringify(bigSlack.payload).includes(`+${firstSection.more} more in the dashboard`), JSON.stringify([firstSection.rows.length, firstSection.more]));
ok('Slack limits: the model returned is the one drawn (the preview shows what is sent)', bigSlack.model.sections.length === 30 && bigSlack.model.kpis.length === 20);
ok('NEGATIVE CONTROL: the same model untrimmed would be 120 sections — over 50 blocks', huge.sections.length + 5 > R.SLACK_MAX_BLOCKS);

const bigTeams = R.renderTeams(huge);
ok(`Teams limits: ${bigTeams.bytes} bytes ≤ ${R.TEAMS_MAX_BYTES} (under the 28 KB a webhook takes)`, bigTeams.bytes <= R.TEAMS_MAX_BYTES && bigTeams.bytes === Buffer.byteLength(JSON.stringify(bigTeams.payload)));
ok('Teams limits: cut and said — fewer rows and sections, "+N more in the dashboard", a note for the UI',
  bigTeams.model.sections.length < 120 && bigTeams.model.more > 0 && JSON.stringify(bigTeams.payload).includes(`+${bigTeams.model.more} more in the dashboard`) && bigTeams.notes.length === 1 && /Teams/.test(bigTeams.notes[0]));
ok('NEGATIVE CONTROL: the untrimmed card is far over the limit', Buffer.byteLength(JSON.stringify(R.renderTeams(huge, Number.MAX_SAFE_INTEGER).payload)) > 28_000);
const midTeams = R.renderTeams(compose([], Array.from({ length: 12 }, (_, i) => wide(i))));
ok('Teams limits: rows go before sections — a middling message keeps every section with fewer rows',
  midTeams.bytes <= R.TEAMS_MAX_BYTES && midTeams.model.sections.length === 12 && midTeams.model.more === 0 && midTeams.model.sections[0].rows.length < M.TOP_ROWS
  && midTeams.model.sections[0].rows.length >= 1 && midTeams.model.sections[0].more === 40 - midTeams.model.sections[0].rows.length,
  JSON.stringify([midTeams.bytes, midTeams.model.sections.length, midTeams.model.sections[0]?.rows.length]));
const fits = R.renderTeams(sample, 1200);
ok('Teams limits: the limit is a parameter of the fit, not a constant baked into the card (a tighter one cuts further)', fits.bytes <= 1200 || fits.model.sections.length === 0, String(fits.bytes));
ok('trimModel: counts what it cut', M.trimModel(huge, { kpis: 5, sections: 2, rows: 1 }).more === 40 + 118 && M.trimModel(huge, { kpis: 5, sections: 2, rows: 1 }).sections[0].more === 39);

finish();
