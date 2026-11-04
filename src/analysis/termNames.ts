// One namespace for the words a project defines (semantic D10): a glossary term's name and its
// "Also called" names are unique across every term AND every metric name, because the Assistant
// matches a word against both — a word that meant two things would resolve to neither. Case- and
// punctuation-blind, as a column's aliases are (../app/columnNames aliasCollision). MAIN.

import { aliasCollision } from '../app/columnNames';
import { listMetrics } from './metrics';
import { listFullTerms } from './terms'; // a cycle with ./terms: both only call each other at run time
import * as msg from '../data/termMessages';

/** The first of `names` a metric or another term already answers to, and whose it is; or null. */
export async function nameClash(projectId: string, names: string[], exceptId?: string): Promise<{ said: string; takenBy: string } | null> {
  const said = names.filter((n) => n.trim());
  if (!said.length) return null;
  const others = [
    ...(await listMetrics(projectId)).filter((m) => m.id !== exceptId).map((m) => ({ name: m.name })),
    ...(await listFullTerms(projectId)).filter((t) => t.id !== exceptId),
  ];
  const hit = aliasCollision(said, others);
  return hit ? { said: hit.alias, takenBy: hit.column.name } : null;
}

/** Why a term cannot be called `name` / also `aliases` (the sentence), or null. `exceptId`: the term being renamed. */
export async function termNameProblem(projectId: string, name: string, aliases: string[], exceptId?: string): Promise<string | null> {
  const clash = await nameClash(projectId, [name, ...aliases], exceptId);
  return clash ? msg.termNameTaken(clash.said, clash.takenBy) : null;
}

/** The name of the term that answers to `name` (its name or an alias), for a metric's save; or null. */
export async function termHolding(projectId: string, name: string): Promise<string | null> {
  const hit = aliasCollision([name], await listFullTerms(projectId));
  return hit ? hit.column.name : null;
}
