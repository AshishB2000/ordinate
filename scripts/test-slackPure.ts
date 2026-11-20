// Ordinate in Slack: the pure parts (no database, no network): the signature, Slack's markup in and out, the
// manifest, the test-only base URL that production refuses, and the shape of a message. Each guard has its control.
//
//   npm run build:ts && node scripts/test-slackPure.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const sig: typeof import('../src/server/slack/signature') = require('../src/server/slack/signature');
const events: typeof import('../src/server/slack/events') = require('../src/server/slack/events');
const render: typeof import('../src/server/slack/render') = require('../src/server/slack/render');
const manifest: typeof import('../src/server/slack/manifest') = require('../src/server/slack/manifest');
const base: typeof import('../src/server/slack/base') = require('../src/server/slack/base');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const secrets: typeof import('../src/server/secrets/store') = require('../src/server/secrets/store');
const say: typeof import('../src/server/slackMessages') = require('../src/server/slackMessages');
const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');

const NOW = 1_800_000_000_000;
const ts = String(NOW / 1000);
const body = '{"type":"event_callback"}';
const good = sig.sign('s3cret', ts, body);
ok('Signature: the right secret and body verify', sig.verifySignature('s3cret', ts, good, body, NOW));
ok('Signature: a changed body fails', !sig.verifySignature('s3cret', ts, good, body + ' ', NOW));
ok('Signature: a wrong secret fails', !sig.verifySignature('other', ts, good, body, NOW));
ok('Signature: a timestamp 6 minutes old fails, 4 minutes passes', !sig.verifySignature('s3cret', ts, good, body, NOW + 6 * 60_000) && sig.verifySignature('s3cret', ts, good, body, NOW + 4 * 60_000));
ok('Signature: a missing or malformed header fails', !sig.verifySignature('s3cret', undefined, good, body, NOW) && !sig.verifySignature('s3cret', ts, undefined, body, NOW) && !sig.verifySignature('s3cret', 'abc', good, body, NOW) && !sig.verifySignature('', ts, good, body, NOW));
ok('Signature: a shorter or longer signature fails without throwing', !sig.verifySignature('s3cret', ts, good.slice(0, -1), body, NOW) && !sig.verifySignature('s3cret', ts, good + 'a', body, NOW));

ok('Markup in: the mention goes, entities decode, a link becomes its label', events.plainText('<@UBOT> what&amp;why &lt;3 <http://x.test|the site> <!channel>') === 'what&why <3 the site');
ok('Markup out: & < > are escaped, so <!channel> and <@U1> can never ping', render.escapeSlack('a & <!channel> <@U1> <http://x|y>') === 'a &amp; &lt;!channel&gt; &lt;@U1&gt; &lt;http://x|y&gt;');
const msg = render.answerMessage({ sentence: 'Total <!here> 5', masked: false, card: null, agent: 'Sales', datasets: ['Orders'], questionId: '11111111-1111-1111-1111-111111111111', openUrl: 'https://bi.test/assistant?slack=1' });
ok('Message: the sentence is escaped in the blocks AND in the notification text', !JSON.stringify(msg).includes('<!here>') && msg.text.includes('&lt;!here&gt;'));
const masked = render.answerMessage({ sentence: 'Alice earned 100', masked: true, card: null, agent: null, datasets: [], questionId: '11111111-1111-1111-1111-111111111111', openUrl: null });
ok('Message: when the share policy hid something the model\'s sentence is replaced by the fixed caption', !JSON.stringify(masked).includes('Alice') && JSON.stringify(masked).includes(say.maskedCaption()));
const card = { kind: 'sql', columns: [{ name: 'a' }, { name: 'b' }], rows: Array.from({ length: 30 }, (_, i) => [`r${i}`, i * 1.5]), rowCount: 30 };
const table = render.tableOf(card);
ok('Table: figures are formatted, a missing cell is a dash, and the total is the engine\'s count', table?.total === 30 && table.rows[1][1] === '1.5' && render.tableOf({ ...card, rows: [[null, null]] })?.rows[0][0] === '–');
const big = render.answerMessage({ sentence: 'x', masked: false, card, agent: null, datasets: [], questionId: '11111111-1111-1111-1111-111111111111', openUrl: null });
const tb = big.blocks.find((b) => (b as { type: string }).type === 'table') as { rows: unknown[] };
ok('Table: at most 20 rows and a header, and the footer says "Open in Ordinate for all"', tb.rows.length === 21 && JSON.stringify(big.blocks).includes('Showing 20 of 30'));
ok('Message: no SQL text or path can come from a card that carries none (the table block holds only cells)', !JSON.stringify(big).includes('SELECT'));

delete process.env.ORDINATE_PUBLIC_URL;
delete process.env.OIDC_REDIRECT_URL;
const ev = manifest.manifestFor('socket') as { settings: { socket_mode_enabled: boolean }; oauth_config: { scopes: { bot: string[] } } };
ok('Manifest: Socket Mode is offered without a public address', ev.settings.socket_mode_enabled === true && manifest.manifestFor('events') === null);
process.env.ORDINATE_PUBLIC_URL = 'https://bi.example.com';
const m = manifest.manifestFor('events') as { settings: { event_subscriptions: { request_url: string; bot_events: string[] } }; oauth_config: { redirect_urls: string[]; scopes: { bot: string[] } } };
ok('Manifest: built from ORDINATE_PUBLIC_URL, with the events and the scopes of the design', m.settings.event_subscriptions.request_url === 'https://bi.example.com/api/slack/events'
  && m.oauth_config.redirect_urls[0] === 'https://bi.example.com/api/slack/connect/callback' && m.settings.event_subscriptions.bot_events.join() === 'app_mention,message.im,app_uninstalled,tokens_revoked'
  && m.oauth_config.scopes.bot.join() === 'app_mentions:read,chat:write,im:history,im:read,im:write,channels:read,groups:read,users:read');
ok('Manifest: asks for none of the scopes the design leaves out', !/users:read\.email|chat:write\.public|channels:join|channels:history|files:write/.test(JSON.stringify(m)));

delete process.env.ORDINATE_TEST_SLACK_BASE;
ok('Base URL: Slack itself unless a test points elsewhere', base.slackOrigin() === 'https://slack.com');
process.env.ORDINATE_TEST_SLACK_BASE = 'http://127.0.0.1:9999';
ok('Base URL: the test override works outside production', base.slackOrigin() === 'http://127.0.0.1:9999');
process.env.ORDINATE_TEST_SLACK_BASE = 'http://evil.example.com';
ok('Base URL: only a loopback http URL is ever accepted', base.slackOrigin() === 'https://slack.com');
process.env.ORDINATE_TEST_SLACK_BASE = 'http://127.0.0.1:9999';
process.env.ORDINATE_ENV = 'prod';
ok('Base URL: production ignores the override (negative control: the same value works above)', base.slackOrigin() === 'https://slack.com');
delete process.env.ORDINATE_ENV;
delete process.env.ORDINATE_TEST_SLACK_BASE;
const baseEnv = { LOG_LEVEL: 'silent', DATA_DIR: '/tmp/x', AUTH_MODE: 'dev' };
const refuses = (extra: Record<string, string>): boolean => { try { envMod.parseEnv({ ...baseEnv, ...extra }); return false; } catch (e) { return /ORDINATE_TEST_SLACK_BASE/.test(String(e)); } };
ok('Env: ORDINATE_ENV=prod refuses ORDINATE_TEST_SLACK_BASE', refuses({ ORDINATE_ENV: 'prod', ORDINATE_TEST_SLACK_BASE: 'http://127.0.0.1:1', DATABASE_URL: 'postgres://x@127.0.0.1/x', AUTH_MODE: 'password', ORDINATE_MASTER_KEY: Buffer.alloc(32, 1).toString('base64') }));
ok('Base URL: a socket URL must be slack.com or a subdomain', base.isSlackUrl('wss://wss-primary.slack.com/link') && !base.isSlackUrl('wss://slack.com.evil.test/link') && !base.isSlackUrl('wss://evil.test/slack.com'));

ok('Secrets: the four Slack kinds are appended, never renamed', ['slack.botToken', 'slack.signingSecret', 'slack.clientSecret', 'slack.appToken'].every((k) => (secrets.SECRET_KINDS as readonly string[]).includes(k)) && secrets.SECRET_KINDS[5] === 'privacy.salt');
ok('Share policy: `slack` is a share path, default mask', privacy.SHARE_PATHS.includes('slack') && privacy.DEFAULT_POLICY.slack === 'mask' && privacy.sanitizePolicy({ slack: 'drop' }).slack === 'drop');

finish();
