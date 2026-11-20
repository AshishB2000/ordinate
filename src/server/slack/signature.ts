// Slack's request signature: HMAC-SHA256 of `v0:<timestamp>:<raw body>` under the app's signing secret, sent
// as `X-Slack-Signature: v0=<hex>` with `X-Slack-Request-Timestamp`. Compared in constant time; a timestamp
// more than five minutes from now is refused (a replay).

import { createHmac, timingSafeEqual } from 'crypto';

export const MAX_SKEW_SEC = 300;

/** The `v0=…` signature of a body. Used by the check and by the test stub that plays Slack. */
export function sign(secret: string, timestamp: string, rawBody: string): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
}

export function verifySignature(secret: string, timestamp: unknown, signature: unknown, rawBody: string, nowMs: number = Date.now()): boolean {
  if (typeof timestamp !== 'string' || typeof signature !== 'string' || !secret || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_SEC) return false;
  const want = Buffer.from(sign(secret, timestamp, rawBody));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}
