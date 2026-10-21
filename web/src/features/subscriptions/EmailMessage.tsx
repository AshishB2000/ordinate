// The email as it will arrive — drawn from the server's model (the cut
// src/analysis/subscriptionEmail.ts renders to HTML and text). Nothing here
// computes or formats a figure; every value and sentence is the server's.

import type { MessageModel } from './api';
import s from './Preview.module.css';

export function EmailMessage({ m, brand, reason }: { m: MessageModel; brand: string; reason: string | null }) {
  return (
    <div className={s.email} data-testid="preview-email">
      <div className={s.emailHead}>
        <span>
          <span className={s.dim}>From</span> {brand}
        </span>
        <span className={s.emailSubject}>{m.title}</span>
      </div>
      <div className={s.emailCard}>
        <div className={s.emailBrand}>{brand}</div>
        <div className={s.emailTitle}>{m.title}</div>
        {m.subtitle.length > 0 && <div className={s.dim}>{m.subtitle.join(' · ')}</div>}
        {m.note && (
          <div className={s.emailNote}>
            {m.noteBy && <strong>Note from {m.noteBy}: </strong>}
            {m.note}
          </div>
        )}
        {m.kpis.length > 0 && (
          <div className={s.emailKpis}>
            {m.kpis.map((k, i) => (
              <div key={i} className={s.emailKpi}>
                <span className={s.dim}>{k.label}</span>
                <span className={s.emailFigure}>{k.value}</span>
                {k.change && <span className={k.tone === 'good' ? s.good : k.tone === 'bad' ? s.bad : s.dim}>{k.change}</span>}
              </div>
            ))}
          </div>
        )}
        {m.sections.map((sec, i) => (
          <div key={i} className={s.emailSection}>
            <div className={s.emailHeading}>{sec.title}</div>
            {sec.caption && <div className={s.dim}>{sec.caption}</div>}
            {sec.note && <em className={s.dim}>{sec.note}</em>}
            {sec.rows.length > 0 && (
              <table className={s.emailTable}>
                {sec.columns.some(Boolean) && (
                  <thead>
                    <tr>
                      {sec.columns.map((c, j) => (
                        <th key={j} scope="col">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {sec.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((v, k) => (
                        <td key={k}>{v}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {sec.more > 0 && <em className={s.dim}>+{sec.more} more in the dashboard</em>}
          </div>
        ))}
        {m.more > 0 && <em className={s.dim}>+{m.more} more in the dashboard</em>}
        {m.link && <span className={s.emailButton}>{m.link.label}</span>}
        {(m.footer || reason) && (
          <div className={s.emailFoot}>
            {m.footer && <span>{m.footer}</span>}
            {reason && <span>{reason}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
