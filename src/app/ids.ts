// The one UUID check. MAIN PROCESS.
//
// Every record id in this app is a generated UUID, and both the dataset store and
// the origin whitelist validate the SHAPE before an id is concatenated into a path
// or trusted as a parent reference — an id like "../.." would otherwise escape a
// project directory. Two copies of that predicate is one copy too many, so it
// lives here and both import it.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}
