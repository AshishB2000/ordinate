// The Get-started tour's visits (GetStarted.tsx): opening a stop's page ticks
// it for this person, from the card or the sidebar. Its own file because the
// shell calls it on every page and should not load the card to do so.

import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { useOnboarding, useVisitTour, type StepId } from '../../api/home';

/** The pages that tick a stop. A dashboard itself counts as Dashboards. */
const PAGES: Array<[prefix: string, step: StepId]> = [
  ['/explore', 'explore'],
  ['/dashboards', 'dashboards'],
  ['/analyses', 'dashboards'],
  ['/reports', 'reports'],
  ['/data', 'data'],
];

/** The stop a path belongs to, if any. */
export function stepFor(pathname: string): StepId | undefined {
  return PAGES.find(([p]) => pathname === p || pathname.startsWith(`${p}/`))?.[1];
}

/**
 * Ticks the stop for the page this person is on. It reads only what Home
 * already fetched, so it asks nothing on a page load of its own, and nothing
 * once the stop is ticked or the tour is over.
 */
export function useTourVisits(): void {
  const { pathname } = useLocation();
  const tour = useOnboarding(false).data;
  const { mutate } = useVisitTour();
  const step = stepFor(pathname);
  const due = !!step && !!tour?.show && tour.steps.some((x) => x.id === step && !x.done);
  useEffect(() => {
    if (due && step) mutate(step);
  }, [due, step, mutate]);
}
