// The dataset page's Data tab (dsGrid.ts / datasets.ts explorer controls):
// the rows in the DataGrid with search, sort, a menu per column (profile,
// sort, rename, type, hide), show / hide columns, and the column profile
// beside the grid. Search, sort and filtering all run on the server against
// the stored Parquet; hiding a column only stops drawing it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { datasetPageSource, type DatasetColumns } from '../../api/datasets';
import { Button } from '../../ui/Button';
import { Checkbox, RadioGroup } from '../../ui/Choice';
import { DataGrid, type GridColumn } from '../../ui/DataGrid/DataGrid';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { Popover } from '../../ui/Popover';
import { failingRowsSource, useColumnDocs, useQualityRules, useWrite, type ColumnType } from './api';
import { ProfilePanel } from './ProfilePanel';
import { ruleWords } from './ruleWords';
import g from './Grid.module.css';

type Sort = { column: string; dir: 'asc' | 'desc' } | null;

/** Rename a column: the whole column list goes back, indexed against the stored one, as the desktop sends it. */
function RenameDialog({ projectId, datasetId, columns, index, onClose }: {
  projectId: string;
  datasetId: string;
  columns: DatasetColumns['columns'];
  index: number;
  onClose: () => void;
}) {
  const current = columns[index]?.name ?? '';
  const [name, setName] = useState(current);
  const [error, setError] = useState('');
  const save = useWrite('dataset:update', ['dataset:columns', 'dataset:stats', 'dataset:profile', 'dataset:list', 'catalog:columns'], {
    quiet: true,
    onDone: (r) => (r.ok === false ? setError(r.error || 'Could not rename the column.') : onClose()),
  });
  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed || trimmed === current) return onClose();
    save.mutate({ projectId, datasetId, columns: columns.map((c, i) => ({ name: i === index ? trimmed : c.name, type: c.type })) });
  };
  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(o) => !o && onClose()}
      title="Rename column"
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <Input
        label="Column name"
        value={name}
        autoFocus
        error={error || undefined}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), submit())}
      />
    </Dialog>
  );
}

type Act = 'profile' | 'asc' | 'desc' | 'unsort' | 'rename' | 'hide' | ColumnType;

/** A column's actions: profile, sort, rename, its type, hide. Opened from its header. */
function ColumnMenu({ column, profiled, sorted, run }: { column: GridColumn; profiled: boolean; sorted: boolean; run: (a: Act) => void }) {
  const item = (act: Act, icon: IconName, label: string) => (
    <Button key={act} variant="ghost" size="sm" icon={icon} className={g.menuItem} onClick={() => run(act)}>
      {label}
    </Button>
  );
  return (
    <div className={g.colMenu}>
      {item('profile', 'chart-bar', profiled ? 'Close the profile' : 'Profile this column')}
      <hr className={g.menuSep} />
      {item('asc', 'arrow-up', 'Sort ascending')}
      {item('desc', 'arrow-down', 'Sort descending')}
      {sorted && item('unsort', 'x', 'Clear sort')}
      <hr className={g.menuSep} />
      {item('rename', 'pencil', 'Rename…')}
      <RadioGroup
        label="Column type"
        orientation="horizontal"
        value={column.type}
        options={[
          { value: 'text', label: 'Text' },
          { value: 'number', label: 'Number' },
          { value: 'date', label: 'Date' },
        ]}
        onValueChange={(v) => run(v as ColumnType)}
      />
      <hr className={g.menuSep} />
      {item('hide', 'eye-off', 'Hide column')}
    </div>
  );
}

export function DataTab({ projectId, datasetId, header }: { projectId: string; datasetId: string; header: DatasetColumns }) {
  const [params, setParams] = useSearchParams();
  const profile = params.get('profile');
  const where = params.get('where');
  const is = params.get('is');
  const ruleId = params.get('rule');
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<number | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const docs = useColumnDocs(projectId, datasetId);
  const rules = useQualityRules(projectId, datasetId);
  const retype = useWrite('dataset:update', ['dataset:columns', 'dataset:stats', 'dataset:profile', 'dataset:list']);

  // A search is a full scan on the server: one query per pause, not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const setParam = (patch: Record<string, string | null>) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) n.delete(k);
        else n.set(k, v);
      }
      return n;
    }, { replace: true });

  const all = header.columns;
  const grid: GridColumn[] = useMemo(
    () => all.flatMap((c, at) => (hidden.has(c.name) ? [] : [{ name: c.name, type: c.type, at }])),
    [all, hidden],
  );
  // A new function is a new query: memoized on everything the server is asked.
  const source = useMemo(() => {
    const q = { ...(search ? { search } : {}), ...(sort ? { sortColumn: sort.column, sortDir: sort.dir } : {}) };
    if (ruleId) return failingRowsSource(projectId, datasetId, ruleId, q);
    const filters = where && is !== null ? [{ type: 'filter' as const, column: where, op: '=', value: is }] : undefined;
    return datasetPageSource(projectId, datasetId, { ...q, ...(filters ? { filters } : {}) });
  }, [projectId, datasetId, search, sort, ruleId, where, is]);

  const rule = ruleId ? rules.data?.rules.find((r) => r.id === ruleId) : undefined;
  const toggleProfile = (name: string) => setParam({ profile: profile === name ? null : name });
  const hide = (name: string) => {
    setHidden((h) => new Set([...h, name]));
    if (profile === name) setParam({ profile: null });
  };

  // The header's content: the name (the catalog's words on hover, accent when
  // profiled) and the sort arrow. A click or Enter on the header opens the
  // column's menu (the grid's one header-activation API, onHeaderActivate).
  const headerCell = (c: GridColumn) => {
    const doc = docs.data?.[c.name];
    const sorted = sort?.column === c.name ? sort.dir : null;
    return (
      <span className={g.thCell}>
        <span
          className={`${g.thName} ${profile === c.name ? g.thOn : ''}`}
          title={[doc?.displayName && `${doc.displayName} — `, doc?.description, doc?.description ? '\n' : '', `${c.name}: profile, sort, rename, type, hide`].filter(Boolean).join('')}
        >
          {c.name}
        </span>
        {sorted && <Icon name={sorted === 'asc' ? 'arrow-up' : 'arrow-down'} size={12} />}
      </span>
    );
  };
  const menuOf = menu === null ? null : grid[menu];

  const banner = rule ? (
    <>
      <Icon name="filter" size={16} />
      <span>
        Showing the rows that fail <strong>{ruleWords(rule)}</strong>
      </span>
    </>
  ) : where && is !== null ? (
    <>
      <Icon name="search" size={16} />
      <span>
        Showing rows where <strong>{where}</strong> is <strong>{is}</strong>
      </span>
    </>
  ) : null;

  return (
    <div className={g.dataTab}>
      <div className={g.toolbar} role="toolbar" aria-label="Rows">
        <Input
          type="search"
          icon="search"
          size="sm"
          className={g.rowSearch}
          aria-label="Search rows"
          placeholder="Search rows…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Popover
          title="Show or hide columns"
          trigger={
            <Button size="sm" icon="columns">
              {hidden.size ? `Columns · ${hidden.size} hidden` : 'Columns'}
            </Button>
          }
        >
          <div className={g.colsMenu}>
            {all.map((c) => (
              <Checkbox
                key={c.name}
                label={c.name}
                checked={!hidden.has(c.name)}
                onCheckedChange={(on) =>
                  setHidden((h) => {
                    const n = new Set(h);
                    if (on) n.delete(c.name);
                    else n.add(c.name);
                    return n;
                  })
                }
              />
            ))}
            {hidden.size > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setHidden(new Set())}>
                Show all columns
              </Button>
            )}
          </div>
        </Popover>
        {sort && (
          <Button size="sm" variant="ghost" icon="x" onClick={() => setSort(null)}>
            Sorted by {sort.column} {sort.dir === 'asc' ? '↑' : '↓'}
          </Button>
        )}
      </div>
      {banner && (
        <div className={g.banner} role="status">
          {banner}
          <Button size="sm" variant="ghost" icon="x" onClick={() => setParam({ rule: null, where: null, is: null })}>
            Clear
          </Button>
        </div>
      )}
      <div className={g.gridRow}>
        <div className={g.gridBox}>
          <DataGrid
            // A rename or a retype is a new header: a new grid re-reads the rows under it.
            key={all.map((c) => `${c.name}:${c.type}`).join('|')}
            columns={grid}
            source={source}
            label={`${header.name} rows`}
            header={headerCell}
            onHeaderActivate={(i, el) => {
              anchor.current = el;
              setMenu(i);
            }}
            emptyTitle={search || banner ? 'No rows match' : 'No rows'}
            emptyBody={search || banner ? 'Nothing in this dataset matches. Clear the search or the filter to see every row.' : 'This dataset has no rows yet.'}
          />
        </div>
        {profile && all.some((c) => c.name === profile) && (
          <ProfilePanel
            projectId={projectId}
            datasetId={datasetId}
            column={profile}
            doc={docs.data?.[profile] ?? {}}
            onClose={() => setParam({ profile: null })}
            onFilter={(value) => {
              setText(value);
              setSearch(value);
            }}
            onRename={() => setRenaming(all.findIndex((c) => c.name === profile))}
          />
        )}
      </div>
      {menuOf && (
        <Popover title={`Column ${menuOf.name}`} heading anchorRef={anchor} open onOpenChange={(o) => !o && setMenu(null)}>
          <ColumnMenu
            column={menuOf}
            profiled={profile === menuOf.name}
            sorted={sort?.column === menuOf.name}
            run={(act) => {
              setMenu(null);
              const at = menuOf.at ?? 0;
              if (act === 'profile') toggleProfile(menuOf.name);
              else if (act === 'asc' || act === 'desc') setSort({ column: menuOf.name, dir: act });
              else if (act === 'unsort') setSort(null);
              else if (act === 'rename') setRenaming(at);
              else if (act === 'hide') hide(menuOf.name);
              else if (act !== menuOf.type) {
                retype.mutate({ projectId, datasetId, columns: all.map((x, k) => ({ name: x.name, type: k === at ? act : x.type })) });
              }
            }}
          />
        </Popover>
      )}
      {renaming !== null && renaming >= 0 && (
        <RenameDialog projectId={projectId} datasetId={datasetId} columns={all} index={renaming} onClose={() => setRenaming(null)} />
      )}
    </div>
  );
}
