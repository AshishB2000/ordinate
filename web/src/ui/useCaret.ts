// Puts a textarea's caret where an edit left it, in the same commit as the new
// text. The editors used requestAnimationFrame, which lands a frame late: keys
// typed in between went in at the end, then the deferred caret moved back over
// them, so "group by" after a completion became `"orders"roup by … g`.

import { useLayoutEffect, useRef, type RefObject } from 'react';

/** Returns `place(at)`: after the next render, focus the textarea and put the caret at `at`. */
export function useCaret(el: RefObject<HTMLTextAreaElement | null>): (at: number) => void {
  const pending = useRef<number | null>(null);
  useLayoutEffect(() => {
    const at = pending.current;
    if (at === null || !el.current) return;
    pending.current = null;
    el.current.focus();
    el.current.setSelectionRange(at, at);
  });
  return (at) => {
    pending.current = at;
  };
}
