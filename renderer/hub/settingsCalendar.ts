'use strict';

// Settings → General → Formats → CALENDAR. Classic global-scope renderer
// <script>: no import/export. Loads before settingsFormats.js, whose init calls
// buildCalendarGroup / paintCalendarGroup, and uses its row builders (sfEl,
// sfRow, sfSelect, sfSeg, sfSegValue, sfSetFormats) at call time.
//
// The calendar is a workspace FORMAT (`formats.calendarType` / `yearEnd`),
// saved and pushed back by main like every other: Gregorian with a fiscal start
// month, a retail 4-4-5 / 4-5-4 / 5-4-4 with its year-end Saturday, or the ISO
// week-year. All the calendar math is main's (src/analysis/retailCalendar.ts);
// the preview line is main's answer (`calendar:today`), never computed here.

const CAL_TYPES: Array<[string, string]> = [
  ['gregorian', 'Gregorian'], ['445', 'Retail 4-4-5'], ['454', 'Retail 4-5-4'], ['544', 'Retail 5-4-4'], ['iso', 'ISO week-year'],
];

/** True when the workspace runs a week calendar (retail or ISO). */
function calIsWeekCal(): boolean {
  const t = wsFormats && wsFormats.calendarType;
  return !!t && t !== 'gregorian';
}

/** What a "month" grain is called: a week calendar's months are its periods. */
function calMonthWord(): string {
  return calIsWeekCal() ? 'Period' : 'Month';
}

let calPreviewSeq = 0;

function buildCalendarGroup(host: HTMLElement): void {
  const head = sfEl('div', 'stp-subhead');
  head.appendChild(sfEl('div', 'stp-subhead-t', 'Calendar'));
  head.appendChild(sfEl('div', 'stp-subhead-d',
    'How weeks, periods, quarters and years are cut — on date axes, relative filters, comparisons, cohorts and scorecards.'));
  host.appendChild(head);

  host.appendChild(sfRow('Calendar', 'Retail calendars run Sunday–Saturday weeks in 4-4-5, 4-5-4 or 5-4-4 periods; ISO weeks run Monday–Sunday.',
    sfSelect('stp-cal-type', CAL_TYPES, (v) => sfSetFormats({ calendarType: v }))));
  const yearEnd = sfRow('Year ends on', 'A 53rd week joins the last period when the rule needs it.',
    sfSeg('stp-cal-yearend', [['nearest', 'Saturday nearest Jan 31'], ['last', 'Last Saturday of January']],
      (v) => sfSetFormats({ yearEnd: v })));
  yearEnd.id = 'stp-cal-yearend-row';
  host.appendChild(yearEnd);
  // The gregorian rows (built by settingsFormats) belong to this group: move them in.
  ['stp-fmt-week', 'stp-fmt-fiscal'].forEach((id) => {
    const row = document.getElementById(id)?.closest('.stp-row');
    if (row) host.appendChild(row);
  });

  const preview = sfEl('div', 'sf-preview cal-preview');
  preview.id = 'stp-cal-preview';
  preview.setAttribute('aria-live', 'polite');
  host.appendChild(preview);
}

function calPreviewCell(k: string, v: string): HTMLElement {
  const cell = sfEl('div', 'sf-preview-cell');
  cell.appendChild(sfEl('span', 'sf-preview-k', k));
  cell.appendChild(sfEl('span', 'sf-preview-v tnum', v));
  return cell;
}

function paintCalendarGroup(): void {
  const p: any = OrdFormat.getFormatPrefs();
  const type = p.calendarType || 'gregorian';
  const weekCal = type !== 'gregorian';
  const sel = document.getElementById('stp-cal-type') as HTMLSelectElement | null;
  if (sel && sel.value !== type) sel.value = type;
  sfSegValue('stp-cal-yearend', p.yearEnd || 'nearest');
  const ye = document.getElementById('stp-cal-yearend-row');
  if (ye) ye.hidden = !weekCal || type === 'iso';
  ['stp-fmt-week', 'stp-fmt-fiscal'].forEach((id) => {
    const row = document.getElementById(id)?.closest('.stp-row') as HTMLElement | null;
    if (row) row.hidden = weekCal;
  });
  // A date axis's month grain reads as what it is under this calendar — on the
  // forms already open and on the template the next one is cloned from.
  const tpl = document.getElementById('viz-encoding-tpl') as HTMLTemplateElement | null;
  [document, tpl && tpl.content].forEach((root) => {
    if (root) root.querySelectorAll('.js-enc-grain option[value="month"]').forEach((o) => { o.textContent = calMonthWord(); });
  });

  const pv = document.getElementById('stp-cal-preview');
  if (!pv) return;
  const seq = ++calPreviewSeq;
  void window.hub.calendarToday().then((r: any) => {
    if (seq !== calPreviewSeq || !r || !r.ok) return;
    pv.innerHTML = '';
    if (r.label) pv.appendChild(calPreviewCell('Today is', r.label));
    if (r.weeks) pv.appendChild(calPreviewCell('This year', r.weeks + '-week year'));
    pv.appendChild(calPreviewCell(weekCal && type === 'iso' ? 'ISO year' : 'Fiscal year', OrdFormat.formatDateRange(r.from, r.to)));
  });
}
