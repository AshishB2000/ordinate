// RS256 JSON Web Tokens with node:crypto — shared by the Snowflake key-pair
// sign-in and the BigQuery service-account token exchange. No dependency: a JWT
// is two base64url JSON objects and one RSA-SHA256 signature.
//
// MAIN PROCESS ONLY. The private key is a secret: it is parsed here, never
// logged, and a parse failure is reported WITHOUT the key text (node's own
// errors carry none, and the message below is fixed).

import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** A PEM private key (PKCS#8 or PKCS#1, encrypted when `passphrase` is given)
 *  → a KeyObject, or null when it does not parse. Never throws. */
export function loadPrivateKey(pem: string, passphrase?: string): KeyObject | null {
  const text = String(pem || '').trim();
  if (!text.includes('PRIVATE KEY')) return null;
  try {
    const key = createPrivateKey(passphrase ? { key: text, format: 'pem', passphrase } : { key: text, format: 'pem' });
    return key.asymmetricKeyType === 'rsa' ? key : null;
  } catch {
    return null;
  }
}

/** `SHA256:<base64 of sha256(DER SubjectPublicKeyInfo)>` — the public-key
 *  fingerprint Snowflake expects in a key-pair JWT's `iss`. */
export function publicKeyFingerprint(key: KeyObject): string {
  // The public half, via its JWK (n, e): the private JWK carries both.
  const { n, e } = key.export({ format: 'jwk' });
  const der = createPublicKey({ key: { kty: 'RSA', n, e }, format: 'jwk' }).export({ type: 'spki', format: 'der' });
  return 'SHA256:' + createHash('sha256').update(der).digest('base64');
}

/** Sign `claims` as a compact RS256 JWT. */
export function signJwtRs256(claims: Record<string, unknown>, key: KeyObject, header: Record<string, unknown> = {}): string {
  const head = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...header }));
  const body = base64url(JSON.stringify(claims));
  const input = `${head}.${body}`;
  const sig = sign('sha256', Buffer.from(input), key);
  return `${input}.${base64url(sig)}`;
}
