'use strict';

// Columns from RELATED datasets in the builder's pickers. Classic global-scope
// renderer <script>: no import/export.
//
// A related column travels through the form's <select>s as ONE string,
// `@<datasetId>/<column>`, so every existing code path that reads a select's
// value keeps working unchanged; `encSplitRefs` turns it back into the
// `{column, datasetId}` main expects on the way out, and `encJoinRefs` does the
// reverse for a saved encoding on the way in. A dataset id is a UUID, so the
// prefix cannot be mistaken for a real header.
//
// Only datasets reachable WITHOUT fan-out are ever listed — main decides that
// (analysis/joinPlan.reachable) and refuses anything else at query time too.

interface EncRelatedCol {
  name: string; // the `@id/column` key
  type: string;
  column: string;
  datasetId: string;
  group: string; // the dataset's name, the optgroup label
}

const ENC_REL_RE = /^@([0-9a-f-]{36})\/([\s\S]*)$/i;

function encFieldKey(datasetId: string, column: string): string {
  return '@' + datasetId + '/' + column;
}

function encParseKey(value: string): { column: string; datasetId?: string } {
  const m = ENC_REL_RE.exec(String(value || ''));
  return m ? { datasetId: m[1], column: m[2] } : { column: value };
}

/** A saved encoding's related references → the form's `@id/column` keys. */
function encJoinRefs(preset: any): any {
  if (!preset || typeof preset !== 'object') return preset;
  const out = { ...preset };
  if (preset.categoryDatasetId && preset.category) out.category = encFieldKey(preset.categoryDatasetId, preset.category);
  if (preset.seriesDatasetId && preset.series) out.series = encFieldKey(preset.seriesDatasetId, preset.series);
  if (Array.isArray(preset.values)) {
    out.values = preset.values.map((v: any) => (v && v.datasetId && v.column ? { ...v, column: encFieldKey(v.datasetId, v.column) } : v));
  }
  delete out.categoryDatasetId;
  delete out.seriesDatasetId;
  return out;
}

/** The form's encoding → what main takes: bare column names plus dataset ids. */
function encSplitRefs(enc: any): any {
  const cat = encParseKey(enc.category);
  enc.category = cat.column;
  if (cat.datasetId) enc.categoryDatasetId = cat.datasetId;
  if (enc.series) {
    const ser = encParseKey(enc.series);
    enc.series = ser.column;
    if (ser.datasetId) enc.seriesDatasetId = ser.datasetId;
  }
  enc.values = (enc.values || []).map((v: any) => {
    const p = encParseKey(v.column);
    return p.datasetId ? { ...v, column: p.column, datasetId: p.datasetId } : v;
  });
  return enc;
}

/**
 * Append related columns to a <select> as one <optgroup> per dataset, nearest
 * first, then put `value` back — `fill` ran before these options existed, so it
 * may have fallen back to the first primary option.
 */
function encAppendRelated(sel: HTMLSelectElement | null, cols: EncRelatedCol[], keep: (c: EncRelatedCol) => boolean, value: string): void {
  if (!sel) return;
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const c of cols) {
    if (!keep(c)) continue;
    let g = groups.get(c.datasetId);
    if (!g) {
      g = document.createElement('optgroup');
      g.label = 'From ' + c.group;
      groups.set(c.datasetId, g);
      sel.appendChild(g);
    }
    const o = document.createElement('option');
    o.value = c.name;
    // The dataset rides in the text too: a closed <select> (and the wells pill
    // that mirrors it) shows the option, not its group.
    o.textContent = c.column + ' · ' + c.group;
    g.appendChild(o);
  }
  if (value && [...sel.options].some((o) => o.value === value)) sel.value = value;
}

// Keyed per project+dataset; a relationship saved or deleted clears it.
const encRelatedCache = new Map<string, Promise<EncRelatedCol[]>>();

function encRelatedInvalidate(): void {
  encRelatedCache.clear();
}

function encLoadRelated(projectId: string, datasetId: string): Promise<EncRelatedCol[]> {
  const key = projectId + '/' + datasetId;
  let p = encRelatedCache.get(key);
  if (!p) {
    p = window.hub.relatedColumns(projectId, datasetId).then((res: any) => {
      const out: EncRelatedCol[] = [];
      for (const g of (res && res.ok && Array.isArray(res.groups)) ? res.groups : []) {
        for (const c of g.columns || []) {
          out.push({ name: encFieldKey(g.datasetId, c.name), type: c.type, column: c.name, datasetId: g.datasetId, group: g.name });
        }
      }
      return out;
    }).catch(() => [] as EncRelatedCol[]);
    encRelatedCache.set(key, p);
  }
  return p;
}
