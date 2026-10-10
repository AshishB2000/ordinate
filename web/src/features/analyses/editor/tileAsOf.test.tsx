import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import { AsOfCaption } from '../../../ui/AsOf';
import type { AsOf } from '../../../ui/asOfView';
import { TileAsOfSlot, useTileAsOf } from './tileAsOf';

const A: AsOf = { at: '2026-10-09T01:00:00.000Z', mode: 'extract' };
const B: AsOf = { at: '2026-10-09T02:00:00.000Z', mode: 'extract' };

function Body({ asOf }: { asOf: AsOf | undefined }) {
  useTileAsOf(asOf);
  return null;
}

/** A card frame as CardView is one: the slot, and the caption in its head. */
function Card({ asOf, shown }: { asOf: AsOf | undefined; shown: boolean }) {
  const [got, setGot] = useState<AsOf | undefined>(undefined);
  return (
    <div>
      <AsOfCaption asOf={got} />
      <TileAsOfSlot.Provider value={setGot}>{shown && <Body asOf={asOf} />}</TileAsOfSlot.Provider>
    </div>
  );
}

const shownAt = () => screen.queryByTestId('as-of')?.getAttribute('datetime') ?? null;

describe('a tile body reports its figure\'s time to its card\'s head', () => {
  it('shows it, follows a new one, and takes it away with the body', () => {
    const { rerender } = render(<Card asOf={A} shown />);
    expect(shownAt()).toBe(A.at);
    rerender(<Card asOf={B} shown />);
    expect(shownAt()).toBe(B.at);
    rerender(<Card asOf={undefined} shown />); // a refusal: no figure, no time
    expect(shownAt()).toBeNull();
    rerender(<Card asOf={A} shown />);
    act(() => rerender(<Card asOf={A} shown={false} />));
    expect(shownAt()).toBeNull();
  });

  it('outside a card (a list preview) there is no slot, and nothing breaks', () => {
    expect(() => render(<Body asOf={A} />)).not.toThrow();
  });
});
