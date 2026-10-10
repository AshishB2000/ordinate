// A scorecard row whose Live figure is missing says why (docs/live-data/log.md,
// L2.6's leftover): the server's sentence in the row itself — readable without
// hovering — for an "off for Live" refusal and for a warehouse failure alike.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ScoreRow } from '../api';
import { Row, rowReason } from './ScorecardPage';

const FAILED = 'The warehouse could not answer this question, and there is no earlier answer to show.';
const OFF = 'This figure would be converted to another currency, which a Live dataset cannot do yet.';
const BASE: ScoreRow = {
  metricId: 'm1', name: 'Revenue', display: '—', targetDisplay: '', attainment: null, attainmentDisplay: '', status: 'none',
  delta: null, deltaDisplay: '', pctDisplay: '', tone: 'flat', spark: [], sparkLabels: [],
};

function draw(r: ScoreRow) {
  return render(
    <table>
      <tbody>
        <Row r={r} selected={false} onOpen={() => undefined} />
      </tbody>
    </table>,
  );
}

describe('a scorecard row with no figure', () => {
  it('a warehouse failure: the server’s sentence, in the row', () => {
    const { container } = draw({ ...BASE, unavailable: { code: 'live_failed', error: FAILED } });
    expect(screen.getByText(FAILED)).toBeTruthy();
    expect(container.querySelector('[data-live-refusal]')).not.toBeNull();
    expect(container.querySelector('tr')?.textContent).toContain('—');
  });

  it('an "off for Live" refusal: its sentence, never the reason code', () => {
    draw({ ...BASE, unavailable: { code: 'live_refused', reason: 'fx', error: OFF } });
    expect(screen.getByText(OFF)).toBeTruthy();
    expect(screen.queryByText('fx')).toBeNull();
  });

  it('NEGATIVE CONTROL: a row that simply has no data says nothing more', () => {
    const { container } = draw(BASE);
    expect(rowReason(BASE)).toBe('');
    expect(container.querySelector('[data-live-refusal]')).toBeNull();
  });
});
