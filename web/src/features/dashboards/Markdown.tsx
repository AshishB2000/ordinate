// A text card's body (legacy textCard.ts renderMarkdownCard + markdown.ts
// mdRender): the Markdown subset as React elements — never HTML — and each
// {{token}} filled in, the textCard order: a dashboard parameter first, else a
// saved metric by name (its figure is the SERVER's display string under the
// sheet's filters), else the token stays as typed, marked missing. Links are
// http(s) only (safeHref) and open in a new tab without an opener.

import { Fragment, type ReactNode } from 'react';
import type { ParamPayload, Step } from '../analyses/api';
import { substitute } from '../analyses/editor/filters';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { useMetricValues, type MetricSummary } from '../analyses/metrics/api';
import { mdParse, mdTokens, type Block, type Inline } from './mdParse';
import s from './Dashboards.module.css';

type Token = (name: string) => { text: string; missing?: boolean };

function inline(nodes: Inline[], token: Token): ReactNode[] {
  return nodes.map((n, i) => {
    if (n.t === 'text') return <Fragment key={i}>{n.v}</Fragment>;
    if (n.t === 'code') return <code key={i}>{n.v}</code>;
    if (n.t === 'b' || n.t === 'i') return n.t === 'b' ? <strong key={i}>{inline(n.c, token)}</strong> : <em key={i}>{inline(n.c, token)}</em>;
    if (n.t === 'a') {
      return (
        <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">
          {inline(n.c, token)}
        </a>
      );
    }
    if (n.t !== 'token') return null;
    const v = token(n.name);
    return (
      <span key={i} className={v.missing ? `${s.token} ${s.tokenMissing}` : s.token} data-token={n.name} title={v.missing ? `No metric or parameter is called ${n.name}` : undefined}>
        {v.text}
      </span>
    );
  });
}

function block(b: Block, i: number, token: Token): ReactNode {
  if (b.t === 'h') {
    // # → h3: a card sits under the page's own headings.
    const H = (['h3', 'h4', 'h5'] as const)[b.level - 1] ?? 'h5';
    return <H key={i} className={s.mdH}>{inline(b.c, token)}</H>;
  }
  if (b.t === 'p') return <p key={i}>{inline(b.c, token)}</p>;
  if (b.t === 'pre') {
    return (
      <pre key={i}>
        <code>{b.v}</code>
      </pre>
    );
  }
  const L = b.t;
  return (
    <L key={i}>
      {b.items.map((it, j) => (
        <li key={j}>{inline(it, token)}</li>
      ))}
    </L>
  );
}

/** Markdown with a fixed token resolver — the pure half, tested on its own. */
export function MarkdownView({ text, token }: { text: string; token: Token }) {
  return <div className={s.md}>{mdParse(text).map((b, i) => block(b, i, token))}</div>;
}

export function TextBody({ projectId, text, params, filters }: { projectId: string; text: string; params: ParamPayload; filters: Step[] }) {
  const names = mdTokens(text);
  const unresolved = names.filter((n) => substitute(`{{${n}}}`, params) === `{{${n}}}`);
  // Metrics are asked for only when a token is not a parameter (textCard.ts txtResolveToken).
  const list = useQuery({
    queryKey: ['metric:list', projectId],
    enabled: unresolved.length > 0,
    queryFn: async () => ((await rpc('metric:list', { projectId })) as { metrics?: MetricSummary[] }).metrics ?? [],
  });
  const byName = new Map((list.data ?? []).map((m) => [m.name.toLowerCase(), m.id]));
  const ids = unresolved.map((n) => byName.get(n.toLowerCase())).filter((x): x is string => !!x);
  const values = useMetricValues(projectId, ids, filters, params);
  if (!text.trim()) return <p className={s.mdEmpty}>Empty text — write Markdown in Properties.</p>;
  const token: Token = (name) => {
    const p = substitute(`{{${name}}}`, params);
    if (p !== `{{${name}}}`) return { text: p };
    const id = byName.get(name.toLowerCase());
    if (id) return { text: values.data?.get(id) ?? '…' };
    return { text: `{{${name}}}`, missing: list.isSuccess };
  };
  return <MarkdownView text={text} token={token} />;
}
