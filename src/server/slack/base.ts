// Where Slack is. Always https://slack.com; the ONE exception is a test harness's local stub of Slack
// (scripts/slackStub.ts), named by ORDINATE_TEST_SLACK_BASE. env.ts refuses that variable under
// ORDINATE_ENV=prod, and this module ignores it there as well, so a production pod cannot be pointed
// anywhere else. Re-read per call, like ../liveEnv.ts.

const SLACK = 'https://slack.com';

/** The origin every Slack call goes to (no trailing slash). */
export function slackOrigin(): string {
  const test = process.env.ORDINATE_TEST_SLACK_BASE;
  if (test && process.env.ORDINATE_ENV !== 'prod') {
    try {
      const u = new URL(test);
      if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.origin;
    } catch {
      // falls through to the real one
    }
  }
  return SLACK;
}

/** True when `raw` is a URL Slack itself may hand us (the Socket Mode socket): slack.com or a subdomain, or the stub's host. */
export function isSlackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const stub = slackOrigin();
    if (stub !== SLACK) return u.hostname === new URL(stub).hostname;
    return (u.protocol === 'https:' || u.protocol === 'wss:') && (u.hostname === 'slack.com' || u.hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
}
