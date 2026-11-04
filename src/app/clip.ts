// The one text clip of stored, untrusted fields: trim, cut to `max`, trim the end again. The last step
// is what makes it idempotent: a cut that lands after a space would otherwise leave that space, which
// the next read-and-save trims (one character shorter). Pure; anything that is not text is ''.

export function clip(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max).trimEnd() : '';
}
