// A screen at phone width, measured: the Dashboards page's phone checks (dashboards-list.e2e.ts for an editor,
// dashboards-list-viewer.e2e.ts for a viewer). Each misfit is a line in `misfits`, so one run names all of them.

import type { Locator, Page } from 'playwright';

/** A phone, as phone.e2e.ts drives one. */
export const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true };
/** The widths checked, the narrow one last (the page is left at it): an iPhone 11/XR, then an iPhone SE/mini. */
const WIDTHS = [414, 375] as const;
/** A thumb's target, each way. The phone dashboard draws 44px (docs/phone-dashboards); 40px is the floor checked. */
const TAP = 40;

/**
 * At each width: the page never scrolls sideways, every `on` (an open menu, a dialog) is wholly on screen, and every
 * element `tap` matches answers a press anywhere in the 40px square around its centre — the hit area, so a target
 * drawn smaller with a larger ::after (Phone.module.css's way) counts as what a thumb gets.
 */
export async function phoneFits(page: Page, misfits: string[], what: string, { on = [], tap = [] }: { on?: Locator[]; tap?: Locator[] } = {}): Promise<void> {
  const height = PHONE.viewport.height;
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height });
    // The document, and the shell's <main>: it scrolls on its own (Shell.module.css .stage), so the page inside it can
    // overflow sideways while the document stays phone-wide.
    const [doc = 0, main = 0] = await page.evaluate(() => [document.documentElement, document.getElementById('main')].map((el) => (el ? el.scrollWidth - el.clientWidth : 0)));
    if (doc > 0 || main > 0) misfits.push(`${what} @${width}: scrolls sideways (the document by ${doc}px, <main> by ${main}px)`);
    for (const l of on) {
      // An open menu follows the resize a frame or two later (Radix repositions it), so this waits for it to land.
      const onScreen = ([el, w, h]: readonly [Element, number, number]) => {
        const b = el.getBoundingClientRect();
        return b.left >= 0 && b.top >= 0 && b.right <= w + 0.5 && b.bottom <= h + 0.5;
      };
      const fits = await page.waitForFunction(onScreen, [await l.elementHandle(), width, height] as const, { timeout: 2000 }).then(() => true, () => false);
      if (!fits) misfits.push(`${what} @${width}: off screen ${JSON.stringify(await l.boundingBox())}`);
    }
    for (const l of tap) {
      for (const one of await l.all()) {
        await one.scrollIntoViewIfNeeded();
        const short = await one.evaluate((el, r) => {
          const b = el.getBoundingClientRect();
          const [x, y] = [b.left + b.width / 2, b.top + b.height / 2];
          const owns = (dx: number, dy: number) => {
            const hit = document.elementFromPoint(x + dx, y + dy);
            return !!hit && el.contains(hit);
          };
          return [owns(-r, 0) && owns(r, 0) ? '' : 'width', owns(0, -r) && owns(0, r) ? '' : 'height'].filter(Boolean).join(' and ');
        }, TAP / 2 - 0.5);
        if (short) misfits.push(`${what} @${width}: “${(await one.getAttribute('aria-label')) ?? (await one.innerText()).trim()}” is under ${TAP}px of ${short}`);
      }
    }
  }
}
