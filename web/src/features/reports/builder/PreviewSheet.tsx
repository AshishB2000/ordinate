// One page drawn at its TRUE size and scaled down to fit (reportRender.ts
// renderPreviewPage + fitPreviewSheet): type on the page is in points, and
// points only mean something against a real page — laid out at pane width a
// slide's title came out three times too big. It reads the same block list the
// three writers read, with the same pictures, so the preview is the file.

import { useLayoutEffect, useRef, useState } from 'react';
import { pageBlocks, pageBox, type PageSetup, type ReadyPage } from '../export/blocks';
import s from './Builder.module.css';

export function PreviewSheet({ page, setup, date }: { page: ReadyPage | null; setup: PageSetup; date: string }) {
  const host = useRef<HTMLDivElement>(null);
  const box = pageBox(setup);
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const fit = () => setScale(Math.min((el.clientWidth - 32) / box.width, (el.clientHeight - 32) / box.height, 1));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [box.width, box.height]);

  return (
    <div ref={host} className={s.stage}>
      <div className={s.scaler} style={{ width: Math.round(box.width * scale), height: Math.round(box.height * scale) }}>
        <div
          className={`${s.sheet} ${page?.kind === 'cover' ? s.cover : ''}`}
          style={{ width: box.width, height: box.height, transform: `scale(${scale})` }}
          data-testid="report-sheet"
          aria-label={page ? `Preview: ${page.title}` : 'Preview'}
        >
          {!page ? (
            <p className={s.sheetEmpty}>Select a page to preview it.</p>
          ) : (
            <>
              {page.kind !== 'cover' && (
                <div className={s.sheetHead}>
                  <span>{setup.name || 'Report'}</span>
                  <span>{date}</span>
                </div>
              )}
              <div className={s.sheetBody}>
                {pageBlocks(page).map((b, i) => {
                  switch (b.t) {
                    case 'logo':
                      return <img key={i} className={s.mark} src={b.src} alt="" />;
                    case 'title':
                      return <h2 key={i} className={s.sheetTitle}>{b.text}</h2>;
                    case 'sub':
                      return <p key={i} className={s.sheetSub}>{b.text}</p>;
                    case 'meta':
                      return <p key={i} className={s.sheetMeta}>{b.text}</p>;
                    case 'para':
                      return <p key={i} className={s.sheetPara}>{b.text}</p>;
                    case 'bullet':
                      return <p key={i} className={s.sheetBullet}>• {b.text}</p>;
                    case 'caption':
                    case 'note':
                      return <p key={i} className={s.sheetCaption}>{b.text}</p>;
                    case 'image':
                      return <img key={i} className={s.sheetImg} src={b.png} alt={b.alt} />;
                    case 'kpis':
                      return (
                        <div key={i} className={s.kpis}>
                          {b.rows.map((k, j) => (
                            <div key={j} className={s.kpi}>
                              <div className={s.kpiValue}>{k.value}</div>
                              <div className={s.kpiLabel}>{k.label}</div>
                            </div>
                          ))}
                        </div>
                      );
                    case 'grid':
                      return (
                        <table key={i} className={s.grid}>
                          <thead>
                            {b.head.map((r, ri) => (
                              <tr key={ri}>
                                {r.map((c, ci) => (
                                  <th key={ci} scope="col">{c}</th>
                                ))}
                              </tr>
                            ))}
                          </thead>
                          <tbody>
                            {b.body.map((r, ri) => (
                              <tr key={ri}>
                                {r.map((c, ci) => (ci === 0 ? <th key={ci} scope="row">{c}</th> : <td key={ci}>{c}</td>))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      );
                    case 'tiles':
                      return (
                        <div key={i} className={s.tiles}>
                          {b.tiles.map((t, j) => (
                            <figure key={j} className={s.tile}>
                              {t.png ? <img src={t.png} alt={t.title} /> : <div className={s.tileMissing}>{t.note || 'Could not be drawn'}</div>}
                              <figcaption>{t.title}</figcaption>
                            </figure>
                          ))}
                        </div>
                      );
                  }
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
