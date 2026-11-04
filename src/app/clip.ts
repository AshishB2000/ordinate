// The one text clip of stored, untrusted fields: trim, cut to `max`, trim the end again. The last step
// is what makes it idempotent: a cut that lands after a space would otherwise lose that space (and
// the character before it) on the next read-and-save. Pure; anything that is not text is ''.

export function clip(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max).trimEnd() : '';
}
