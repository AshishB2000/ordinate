import { describe, expect, it } from 'vitest';
import { NAV, type NavItem } from './nav';
import { NAV_GROUPS, type NavGroup } from './navGroups';

/** Every main NAV route in exactly one group; the foot in none; no group naming a route NAV lacks. */
function problems(nav: readonly NavItem[], groups: readonly NavGroup[]): string[] {
  const out: string[] = [];
  for (const n of nav) {
    const inGroups = groups.filter((g) => g.items.includes(n.to)).length;
    if (n.bottom && inGroups) out.push(`${n.to} is in the foot and a group`);
    if (!n.bottom && inGroups === 0) out.push(`${n.to} is in no group`);
    if (inGroups > 1 || groups.some((g) => g.items.filter((t) => t === n.to).length > 1)) out.push(`${n.to} is in two groups`);
  }
  for (const g of groups) for (const to of g.items) if (!nav.some((n) => n.to === to)) out.push(`${g.label} names ${to}, which the nav does not have`);
  return out;
}

describe('the nav groups', () => {
  it('place every section once: View, Build, and the foot', () => {
    expect(problems(NAV, NAV_GROUPS)).toEqual([]);
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(['View', 'Build']);
  });

  it('fail on a planted entry in no group, one in two, and a stale one (negative control)', () => {
    const planted: NavItem = { to: '/planted', label: 'Planted', icon: 'plus' };
    expect(problems([...NAV, planted], NAV_GROUPS)).toEqual(['/planted is in no group']);
    expect(problems(NAV, [...NAV_GROUPS, { label: 'Again', items: ['/data'] }])).toEqual(['/data is in two groups']);
    expect(problems(NAV.filter((n) => n.to !== '/reports'), NAV_GROUPS)).toEqual(['View names /reports, which the nav does not have']);
  });
});
