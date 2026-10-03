// Every RPC contract, merged. Append-only: one import and one spread per area
// file, so parallel screen ports never conflict here.

import type { Contract } from './contract';
import { projects } from './projects';
import { datasets } from './datasets';
import { home } from './home';
import { quality } from './quality';
import { visuals } from './visuals';

export const contracts = {
  ...projects,
  ...datasets,
  ...home,
  ...quality,
  ...visuals,
} as const;

export type Channel = keyof typeof contracts;

/** The contract for a channel, or undefined — own keys only, so "toString" is not a channel. */
export function contractFor(channel: string): Contract | undefined {
  return Object.prototype.hasOwnProperty.call(contracts, channel) ? contracts[channel as Channel] : undefined;
}
