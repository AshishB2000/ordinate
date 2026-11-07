// A recording FactsQuery for the SQL families' facts readers (mysqlFacts, mssqlFacts, oracleFacts,
// snowflakeFacts). No socket, no driver: the reader gets `open`, which counts how often a connection
// would have been made, and a query function that records each statement and answers from a fixture.
// Not a suite itself.

import type { FactsReply, OpenFacts } from '../src/connectors/tableFacts';

export type Param = string | number | null;
export interface Sent { sql: string; params: Param[] }
export type Answer = (sql: string, params: Param[]) => unknown[][] | Promise<unknown[][]>;

export interface Facts {
  rec: Sent[];
  /** How many times the reader asked for a connection. */
  opened: () => number;
  open: OpenFacts;
}

export function recorder(answer: Answer): Facts {
  const rec: Sent[] = [];
  let opened = 0;
  const open: OpenFacts = async (read) => {
    opened++;
    return read(async (sql, params) => {
      rec.push({ sql, params });
      return answer(sql, params);
    });
  };
  return { rec, opened: () => opened, open };
}

/** Rows by catalog: the first pattern the statement matches answers it, anything else answers nothing. */
export const byCatalog = (rows: [RegExp, unknown[][]][]): Answer => (sql) => rows.find(([re]) => re.test(sql))?.[1] ?? [];

/** `answer`, except a statement matching `re` is refused, as a warehouse refuses a catalog the role cannot read. */
export const refusing = (answer: Answer, re: RegExp): Answer => (sql, params) => {
  if (re.test(sql)) throw new Error(`permission denied (${sql.match(re)?.[0]})`);
  return answer(sql, params);
};

export const factsOf = (r: FactsReply) => (r.ok ? r : null);
