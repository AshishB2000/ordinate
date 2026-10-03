// One icon. The geometry is generated (paths.ts, from renderer/hub/icons.ts);
// this only stamps the house frame around it. 16px everywhere, 20 in the
// section rail — there is no other size (icons.ts explains why).
//
// Decorative by default (aria-hidden): the control around it carries the name.
// Pass `label` only for an icon that stands alone as content.

import { ICON_PATHS, type IconName } from './paths';

export type { IconName };

export function Icon({ name, size = 16, label }: { name: IconName; size?: 16 | 20 | 24 | 12; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
      // Generated, hand-authored geometry from paths.ts only — never data.
      // SVG markup carries no style attribute, so the CSP is untouched.
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  );
}

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];
