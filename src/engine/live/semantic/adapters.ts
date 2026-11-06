// The semantic-layer backends this server can ask, and the executor's runner over them (semantic layer part 7, b2;
// docs/semantic-layer/07-portability.md D14, D15, D18) — MAIN PROCESS ONLY.
//
// One encoder per backend turns b1's neutral `SemanticQuery` into that layer's own request (c1 Snowflake, e1 Cube,
// d1 dbt each add theirs here). The runner sends every encoded question through `warehouse()` — the ONE Live door:
// slotted, counted, timed out, cancelled — and reads the rows back by the query's own column names.

import type { SemanticBackendId } from '../../../connectors/types';
import type { SemanticRequest } from '../../../connectors/semanticRun';
import * as queryCache from '../../queryCache';
import { isRefusal } from '../liveSpec';
import type { LiveColumn } from '../liveSpec';
import type { LiveTarget } from '../liveTarget';
import type { LiveRefusal } from '../liveSpec';
import { warehouse } from '../liveWarehouse';
import { cubeAdapter } from './cube';
import { dbtAdapter } from './dbt';
import type { SemanticRunner } from './evaluateSemantic';
import type { SemanticQuery } from './semanticQuery';
import { snowflakeAdapter } from './snowflake';

export interface SemanticAdapter {
  /**
   * The layer's request for one question; `columns` are `answerColumns(q)`, the names its rows come back under.
   * `dimensions` are the dataset's declared ones (their types), for a backend that reads each by its type. A
   * question the layer cannot express exactly comes back as its refusal (e1: Cube's `layerFilter`), worded with `names`.
   */
  encode(q: SemanticQuery, model: string, dimensions?: readonly LiveColumn[], names?: { dataset: string; layer: string }): SemanticRequest | LiveRefusal;
}

/** The shipped backends' encoders (c1 Snowflake; e1 and d1 add theirs): a semantic dataset of an unknown backend is unavailable. */
export const ADAPTERS: Partial<Record<SemanticBackendId, SemanticAdapter>> = { snowflake: snowflakeAdapter, cube: cubeAdapter, dbt: dbtAdapter };

const TEST_ONLY = new Map<SemanticBackendId, SemanticAdapter>();

/** A test's encoder (scripts/semanticFake.ts's layer). Refused under ORDINATE_ENV=prod; never replaces a shipped one. */
export function registerTestSemanticAdapter(backend: SemanticBackendId, adapter: SemanticAdapter): void {
  if (process.env.ORDINATE_ENV === 'prod') throw new Error('[semantic] test adapters cannot be registered when ORDINATE_ENV=prod');
  if (Object.prototype.hasOwnProperty.call(ADAPTERS, backend)) throw new Error(`[semantic] "${backend}" is a shipped backend`);
  TEST_ONLY.set(backend, adapter);
}

export function adapterFor(backend: SemanticBackendId): SemanticAdapter | null {
  return (Object.prototype.hasOwnProperty.call(ADAPTERS, backend) ? ADAPTERS[backend] : TEST_ONLY.get(backend)) ?? null;
}

/**
 * The executor's runner for a semantic target: each question encoded by its backend and sent through the one door
 * under `shared` (the flight's signal). `seen` hears when each answer came, so a figure is as old as its oldest one.
 */
export function semanticRunner(t: LiveTarget, shared: AbortSignal, seen: (ms: number) => void): SemanticRunner {
  const adapter = t.semantic ? adapterFor(t.semantic.backend) : null;
  const encode = (q: SemanticQuery): SemanticRequest | LiveRefusal => {
    if (!adapter || !t.semantic) throw new Error('no adapter for this semantic layer'); // liveTarget refused it first
    return adapter.encode(q, t.semantic.model, t.semantic.env.columns, { dataset: t.semantic.env.dataset, layer: t.semantic.env.layer });
  };
  const run: SemanticRunner = async (q) => {
    const req = encode(q);
    if (isRefusal(req)) return req;
    const rows = await warehouse(t, req, shared);
    seen(queryCache.now());
    return isRefusal(rows) ? rows : { columns: req.columns.slice(), rows };
  };
  run.check = (q) => {
    try {
      const req = encode(q);
      return isRefusal(req) ? req : null;
    } catch {
      return null; // the question itself throws when asked
    }
  };
  return run;
}
