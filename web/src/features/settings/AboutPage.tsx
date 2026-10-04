// About Ordinate — replaces the desktop's About panel and Settings → About:
// the version, the links, and the licences of every production package the
// app ships (web/scripts/licenses.ts writes licenses.json at build time; it
// is fetched only when this page opens). The desktop's troubleshooting rows
// were about Screen Recording permission and a local CLI — neither exists on
// a server — and are gone.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Page } from '../../app/blocks';
import { Badge } from '../../ui/Badge';
import { Input } from '../../ui/Field';
import { SkeletonRows } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { HELP_LINKS } from '../palette/appCommands';
import type { Licences } from '../../../scripts/licenses';
import s from './Settings.module.css';
import a from './About.module.css';

async function fetchLicences(): Promise<Licences> {
  const res = await fetch('/licenses.json', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`The licence list could not be loaded (${res.status}).`);
  return (await res.json()) as Licences;
}

const LINKS: Array<{ href: string; icon: IconName; title: string; desc: string }> = [
  { href: HELP_LINKS.source, icon: 'code', title: 'Source on GitHub', desc: 'MIT licensed. Read it, build it, run it yourself.' },
  { href: HELP_LINKS.whatsNew, icon: 'sparkles', title: "What's new", desc: 'Release notes for every version.' },
  { href: HELP_LINKS.help, icon: 'message-square', title: 'Help and feedback', desc: 'Report a problem or ask for something.' },
];

function Packages({ data }: { data: Licences }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? data.packages.filter((p) => p.name.toLowerCase().includes(t) || p.license.toLowerCase().includes(t)) : data.packages;
  }, [q, data]);
  return (
    <>
      <div className={a.bar}>
        <div className={a.search}>
          <Input icon="search" aria-label="Filter packages" placeholder="Filter by name or licence" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className={s.note} data-testid="licence-count">
          {shown.length === data.packages.length ? `${data.packages.length} packages` : `${shown.length} of ${data.packages.length} packages`}
        </span>
      </div>
      {shown.length === 0 ? (
        <EmptyState icon="search" title="No package matches" heading={3} compact>
          Nothing named or licensed like “{q.trim()}”.
        </EmptyState>
      ) : (
        <ul className={a.list} aria-label="Bundled packages">
          {shown.map((p) => (
            <li key={`${p.name}@${p.version}`} className={a.pkg}>
              <details>
                <summary>
                  <span className={a.pkgName}>{p.name}</span>
                  <span className={a.pkgVersion}>{p.version}</span>
                  <Badge tone={p.license === 'UNKNOWN' ? 'warn' : 'neutral'}>{p.license === 'UNKNOWN' ? 'Licence not stated' : p.license}</Badge>
                  {p.url && (
                    <a className={a.src} href={p.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
                      Source <Icon name="external-link" size={12} />
                    </a>
                  )}
                </summary>
                {p.text ? <pre className={a.text}>{p.text}</pre> : <p className={s.note}>This package ships no licence file; its package.json names {p.license === 'UNKNOWN' ? 'none' : p.license}.</p>}
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function AboutPage() {
  const q = useQuery({ queryKey: ['licenses.json'], queryFn: fetchLicences, staleTime: Infinity });
  return (
    <Page title="About Ordinate" sub="A self-hosted, open-source BI workspace. Ordinate does the math itself; a model you bring only puts its figures into words.">
      <div className={a.hero}>
        <img className={a.mark} src="/favicon.svg" width={48} height={48} alt="" />
        <div className={a.heroText}>
          <span className={a.name}>Ordinate</span>
          <span className={s.note} data-testid="about-version">
            {q.isPending ? 'Version …' : q.data ? `Version ${q.data.app.version}` : 'Version unknown'}
          </span>
        </div>
      </div>
      <nav className={a.links} aria-label="Links">
        {LINKS.map((l) => (
          <a key={l.href} className={s.linkCard} href={l.href} target="_blank" rel="noopener noreferrer">
            <span className={s.linkIcon}>
              <Icon name={l.icon} />
            </span>
            <span className={s.linkText}>
              <span className={s.linkTitle}>
                {l.title} <Icon name="external-link" size={12} />
              </span>
              <span className={s.linkDesc}>{l.desc}</span>
            </span>
          </a>
        ))}
      </nav>
      <section className={s.group} aria-labelledby="about-licences">
        <header className={s.groupHead}>
          <h2 className={s.groupTitle} id="about-licences">
            Open-source licences
          </h2>
          <p className={s.groupDesc}>Every package this server and its web app ship, with the licence each is used under. Open one for its full text.</p>
        </header>
        <div className={s.pad}>
          {q.isPending ? (
            <SkeletonRows rows={8} label="Loading licences" />
          ) : q.isError ? (
            <ErrorState heading={3} title="The licence list could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />
          ) : (
            <Packages data={q.data} />
          )}
        </div>
      </section>
    </Page>
  );
}
