// Upload a file, or paste a table (legacy dsImport.ts): each parses on the
// server — an upload through POST /api/files and dataset:pickAndParse, a paste
// through dataset:parsePaste — and the parsed table is STAGED there; the
// composer works from the stage, never from rows sent back over HTTP.
//
// A workbook with several sheets stays here for a beat: the sheet picker is
// part of choosing the source, so the chosen sheet previews before the
// composer opens on it (changing the sheet uploads the file again — an upload
// token is single-use).

import { useMemo, useState } from 'react';
import { formatNumber } from '../../../../src/app/format.ts';
import { upload } from '../../api/client';
import { Button } from '../../ui/Button';
import { DataGrid } from '../../ui/DataGrid/DataGrid';
import { Textarea } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { SkeletonTable } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { parsePaste, parseUpload, type ComposeInput, type ParsePreview } from './api';
import type { ComposerStart } from './Composer';
import { DropZone } from './DropZone';
import s from './Import.module.css';

const ACCEPT = '.csv,.tsv,.json,.xlsx,.parquet,text/csv,text/tab-separated-values,application/json';
/** Just under the RPC body cap (src/api/datasets.ts `dataset:parsePaste`). */
const MAX_PASTE = 900_000;

type Kind = NonNullable<ComposeInput['sourceKind']>;
const KINDS: readonly Kind[] = ['csv', 'json', 'xlsx', 'parquet', 'paste'];

/** The dataset name a file suggests: its name without the extension. */
export const nameOf = (file: string): string => {
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
};

/** The composer's start from a staged parse. */
export function startFrom(label: string, kind: string, p: ParsePreview, sheet?: string): ComposerStart {
  const sourceKind = (KINDS as readonly string[]).includes(kind) ? (kind as Kind) : undefined;
  return {
    base: { label, rows: p.rowCount, kind, ref: { inline: { name: label, ...(p.stagedId ? { stagedId: p.stagedId } : {}) } }, columns: p.columns.map((c) => c.name) },
    name: label,
    ...(sourceKind ? { sourceKind } : {}),
    warnings: p.warnings,
    ...(sheet ? { sheet } : {}),
  };
}

const size = (p: ParsePreview) =>
  `${formatNumber(p.rowCount)} row${p.rowCount === 1 ? '' : 's'} × ${p.columns.length} column${p.columns.length === 1 ? '' : 's'}`;

interface Sheets {
  file: File;
  kind: string;
  sheet: string;
  preview: ParsePreview;
}

function SheetPicker({ at, busy, onSheet, onUse }: { at: Sheets; busy: boolean; onSheet: (sheet: string) => void; onUse: () => void }) {
  const rows = at.preview.rows;
  const source = useMemo(() => async (o: number, l: number) => ({ rows: rows.slice(o, o + l), total: rows.length }), [rows]);
  return (
    <div className={s.sheets}>
      <div className={s.sheetBar}>
        <Select label="Sheet" value={at.sheet} options={(at.preview.sheetNames ?? []).map((n) => ({ value: n, label: n }))} onValueChange={onSheet} disabled={busy} />
        <p className={s.sheetNote}>
          {at.preview.rowCount > rows.length ? `${size(at.preview)} — showing the first ${formatNumber(rows.length)}` : size(at.preview)}
        </p>
        <Button variant="primary" onClick={onUse} disabled={busy}>
          Use this sheet
        </Button>
      </div>
      <div className={s.gridHost}>
        {busy ? <SkeletonTable label="Reading the sheet" /> : <DataGrid columns={at.preview.columns} source={source} label={`${at.sheet} preview`} />}
      </div>
    </div>
  );
}

export function FileSource({ onComposer }: { onComposer: (start: ComposerStart) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheets, setSheets] = useState<Sheets | null>(null);

  const take = async (file: File, sheet?: string) => {
    setError(null);
    setBusy(file.name);
    try {
      const up = await upload(file, file.name);
      const r = await parseUpload(up.fileToken, sheet);
      if (!r.ok) return setError(r.error);
      if (r.canceled) return;
      const kind = r.sourceKind ?? 'csv';
      const names = r.preview.sheetNames ?? [];
      if (names.length > 1) {
        setSheets({ file, kind, sheet: sheet ?? names[0], preview: r.preview });
        return;
      }
      onComposer(startFrom(nameOf(file.name), kind, r.preview));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The file could not be read.');
    } finally {
      setBusy(null);
    }
  };

  if (sheets) {
    return (
      <SheetPicker
        at={sheets}
        busy={busy !== null}
        onSheet={(sheet) => void take(sheets.file, sheet)}
        onUse={() => onComposer(startFrom(nameOf(sheets.file.name), sheets.kind, sheets.preview, sheets.sheet))}
      />
    );
  }
  if (busy) return <SkeletonTable label={`Reading ${busy}`} />;
  return (
    <div className={s.paneStack}>
      {error && <ErrorState compact heading={3} title="That file could not be imported" message={error} />}
      <DropZone
        icon="upload"
        title="Drop a file here"
        hint="CSV, TSV, JSON, Excel (.xlsx) or Parquet — up to a million rows. It is read on the server, and nothing is saved until you press Save."
        accept={ACCEPT}
        choose="Choose a file"
        onFile={(f) => void take(f)}
      />
    </div>
  );
}

export function PasteSource({ onComposer }: { onComposer: (start: ComposerStart) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const tooBig = text.length > MAX_PASTE;
  const parse = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await parsePaste(text);
      if (!r.ok) return setError(r.error);
      if (r.preview.columns.length === 0) return setError('There is no table in that text — paste rows with a header line.');
      onComposer(startFrom('Pasted data', 'paste', r.preview));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The pasted text could not be parsed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={s.paneStack}>
      <Textarea
        label="Paste a table"
        hint={tooBig ? undefined : 'CSV, TSV or JSON — copy cells from a spreadsheet and paste them here. The first line names the columns.'}
        error={tooBig ? 'Too much to paste — save it as a .csv or .tsv file and upload it instead.' : error}
        rows={14}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className={s.paste}
        spellCheck={false}
      />
      <div className={s.paneActions}>
        <Button variant="primary" onClick={() => void parse()} loading={busy} disabled={!text.trim() || tooBig}>
          Parse
        </Button>
      </div>
    </div>
  );
}
