// AWS Signature Version 4 for one request — MAIN PROCESS ONLY. Node's crypto, no SDK.
// The algorithm: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
// Checked against AWS's own published test vectors (scripts/test-connectorsAthena).

import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignInput {
  method: string;
  host: string;
  /** Already URI-encoded. Athena's is always "/". */
  path: string;
  region: string;
  service: string;
  /** Headers to sign besides host and x-amz-date, names in lower case. */
  headers: Record<string, string>;
  body: string;
  creds: AwsCredentials;
  now?: Date;
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: Buffer | string, s: string): Buffer => createHmac('sha256', key).update(s, 'utf8').digest();

/** The derived signing key for one day, region and service. */
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request');
}

/** The headers to send: the given ones, x-amz-date and authorization. Host is left to the URL. */
export function signV4(r: SignInput): Record<string, string> {
  const amzDate = (r.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20150830T123600Z
  const date = amzDate.slice(0, 8);
  const all: Record<string, string> = { ...r.headers, host: r.host, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signed = names.join(';');
  const request = [r.method, r.path, '', canonicalHeaders, signed, sha256Hex(r.body)].join('\n');
  const scope = `${date}/${r.region}/${r.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(request)].join('\n');
  const signature = createHmac('sha256', signingKey(r.creds.secretAccessKey, date, r.region, r.service)).update(toSign, 'utf8').digest('hex');
  const { host: _host, ...send } = all;
  return { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${r.creds.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}
