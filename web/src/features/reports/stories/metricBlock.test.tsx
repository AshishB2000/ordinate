// A story's metric block that the server refused (a layer's metric it could not ask, part 7 b3): the server's
// sentence, never a crash or a retry. NEGATIVE CONTROL: a block with figures draws them.

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { StoryBlockRow, type BlockProps } from './StoryBlock';
import type { MetricFigure } from '../api';

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const noop = () => {};

function mount(figure: MetricFigure) {
  const props: BlockProps = {
    projectId: P, block: { id: 'b1', kind: 'metrics_row', metricIds: [M], filters: [] }, index: 0, count: 1, editing: false, readOnly: true,
    figure, figuresPending: false, onChange: noop, onEdit: noop, onEndEdit: noop, onAddAfter: noop, onPickInto: noop, onMove: noop,
    onDuplicate: noop, onRemove: noop, onBackspaceEmpty: noop, onPin: noop, onDragHandle: noop,
  };
  render(<MemoryRouter><StoryBlockRow {...props} /></MemoryRouter>);
}

describe('a story metric block', () => {
  it('refused off for the layer: the server\'s sentence through the refusal state, no retry', () => {
    mount({ ok: false, code: 'live_refused', reason: 'metricMissing', error: 'Fake layer no longer defines max_amount.' });
    expect(screen.getByText('Fake layer no longer defines max_amount.')).toBeTruthy();
    expect(document.querySelector('[data-live-refusal]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /try again|retry/i })).toBeNull();
  });

  it('refused with a code the refusal state does not know: the server\'s sentence all the same', () => {
    mount({ ok: false, code: 'external_metric', reason: 'pending', error: 'revenue is defined in a semantic layer this server does not ask yet.' });
    expect(screen.getByText(/revenue is defined in a semantic layer/)).toBeTruthy();
  });

  it('NEGATIVE CONTROL: a block with figures draws them', () => {
    mount({ figures: [{ name: 'Revenue', display: '12.3K', value: 12300 }], caption: '' });
    expect(screen.getByText('12.3K')).toBeTruthy();
    expect(screen.getByText('Revenue')).toBeTruthy();
  });
});
