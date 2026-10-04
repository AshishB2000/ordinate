// Every RPC contract, merged. Append-only: one import and one spread per area
// file, so parallel screen ports never conflict here.

import type { Contract } from './contract';
import { projects } from './projects';
import { datasets } from './datasets';
import { home } from './home';
import { quality } from './quality';
import { visuals } from './visuals';
import { adminContracts } from './admin';
import { tokens } from './tokens';
import { maps } from './maps';
import { connections } from './connections';
import { assistant } from './assistant';
import { captures } from './captures';
import { inputTables } from './inputTables';
import { catalog } from './catalog';
import { lineage } from './lineage';
import { relationships } from './relationships';

import { trash } from './trash';
import { versions } from './versions';
import { prepare } from './prepare';

export const contracts = {
  ...projects,
  ...datasets,
  ...home,
  ...quality,
  ...visuals,
  ...adminContracts,
  ...tokens,
  ...maps,
  ...connections,
  ...assistant,

  ...trash,
  ...versions,
  ...captures,
  ...inputTables,
  ...catalog,
  ...lineage,
  ...relationships,
  ...prepare,
} as const;

export type Channel = keyof typeof contracts;

/** The contract for a channel, or undefined — own keys only, so "toString" is not a channel. */
export function contractFor(channel: string): Contract | undefined {
  return Object.prototype.hasOwnProperty.call(contracts, channel) ? contracts[channel as Channel] : undefined;
}
