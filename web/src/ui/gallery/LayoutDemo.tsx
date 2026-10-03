// Gallery: empty / error / loading states, Panel + Splitter, and every icon.

import { Button } from '../Button';
import { ICON_NAMES, Icon } from '../icons/Icon';
import { Panel } from '../Panel';
import { PageSkeleton, SkeletonBlock, SkeletonRows, SkeletonTable } from '../Skeleton';
import { Splitter, useStoredSize } from '../Splitter';
import { EmptyState, ErrorState } from '../States';
import { Cell, Grid, Section } from './Demo';
import g from './Gallery.module.css';

export function StatesDemo() {
  return (
    <Section id="states" title="EmptyState · ErrorState · Skeleton" note="Every list, panel and chart designs all three (plan §7).">
      <Grid>
        <Cell label="EmptyState: page, with actions" wide>
          <EmptyState
            icon="database"
            title="No datasets yet"
            actions={
              <>
                <Button variant="primary" icon="upload">
                  Import a file
                </Button>
                <Button variant="ghost" icon="plug">
                  Connect a source
                </Button>
              </>
            }
          >
            Bring data in from a file, a database or a URL. Everything you build starts from a dataset.
          </EmptyState>
        </Cell>
        <Cell label="EmptyState: compact (rail, dropdown)">
          <EmptyState icon="star" title="Nothing starred" compact heading={3}>
            Star a dashboard to keep it here.
          </EmptyState>
        </Cell>
        <Cell label="ErrorState: page, with retry">
          <ErrorState title="Datasets could not be loaded" message="The server did not answer (502)." onRetry={() => {}} />
        </Cell>
        <Cell label="ErrorState: compact, no retry">
          <ErrorState compact heading={3} title="Preview failed" message="Column “amount” is text." />
        </Cell>
        <Cell label="SkeletonRows (a list)">
          <SkeletonRows rows={4} label="Loading datasets" />
        </Cell>
        <Cell label="SkeletonTable (a grid)" wide>
          <SkeletonTable rows={6} cols={5} label="Loading rows" />
        </Cell>
        <Cell label="SkeletonBlock (a chart)">
          <div className={g.chartHost}>
            <SkeletonBlock label="Loading chart" />
          </div>
        </Cell>
        <Cell label="PageSkeleton (a lazy route)" wide>
          <div className={g.pageHost}>
            <PageSkeleton />
          </div>
        </Cell>
      </Grid>
    </Section>
  );
}

export function LayoutDemo() {
  const [size, setSize, commit] = useStoredSize('ordinate.gallery.panel', 280, 200, 420);
  return (
    <Section id="layout" title="Panel · Splitter" note="Drag the divider, or focus it and use ←/→ Home/End; the width is remembered.">
      <div className={g.split}>
        <div className={g.splitMain}>
          <p className={g.prose}>The page. A Panel sits beside it and pushes it over rather than covering it.</p>
        </div>
        <Splitter
          size={size}
          min={200}
          max={420}
          pane="after"
          label="Resize the history panel"
          onSizeChange={setSize}
          onCommit={commit}
        />
        {/* React sets `style` through the CSSOM, which style-src 'self' allows. */}
        <div className={g.splitSide} style={{ width: size }}>
          <Panel
            title="Version history"
            sub="Dashboard · 14 versions"
            onClose={() => {}}
            footer={
              <Button variant="primary" size="sm">
                Restore
              </Button>
            }
          >
            <EmptyState icon="history" title="No other versions" compact heading={3}>
              Each save adds one.
            </EmptyState>
          </Panel>
        </div>
      </div>
    </Section>
  );
}

export function IconsDemo() {
  return (
    <Section id="icons" title={`Icon · ${ICON_NAMES.length}`} note="Generated from renderer/hub/icons.ts by web/scripts/gen-icons.mjs. 16px; 20 in the rail.">
      <ul className={g.icons}>
        {ICON_NAMES.map((n) => (
          <li key={n} className={g.icon}>
            <Icon name={n} size={20} />
            <span>{n}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
