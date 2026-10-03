// A source's mark: the brand glyph (one SVG path from simple-icons), a bundled
// image (a data: URI from the server), or the label's initials in the same
// 42px tile — hub.css `.conn-logo`. Decorative: the tile beside it names it.

import { useState } from 'react';
import type { Logo } from './api';
import s from './Connections.module.css';

export function initials(label: string): string {
  const words = label.replace(/\([^)]*\)/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function ConnLogo({ logo, label, small }: { logo?: Logo; label: string; small?: boolean }) {
  const [broken, setBroken] = useState(false);
  const cls = small ? `${s.logo} ${s.logoSm}` : s.logo;
  if (logo && 'src' in logo && !broken) {
    return (
      <span className={cls} aria-hidden="true">
        <img src={logo.src} alt="" onError={() => setBroken(true)} />
      </span>
    );
  }
  if (logo && 'path' in logo) {
    return (
      <span className={cls} aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d={logo.path} fill={logo.color} />
        </svg>
      </span>
    );
  }
  return (
    <span className={`${cls} ${s.logoFallback}`} aria-hidden="true">
      {initials(label)}
    </span>
  );
}
