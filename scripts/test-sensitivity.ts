// Self-check for src/data/sensitivity.ts — the detectors that PROPOSE a
// sensitivity level for a column. Every detector is held to a true positive AND
// a false positive that looks like it: a Luhn-valid card vs an invalid one, a
// mod-97-valid IBAN vs a one-digit-off one, an IP vs a version number, a name vs
// an ordinary pair of capitalised words, `email` vs `email_sent`.
//
//   npm run build:ts && node scripts/test-sensitivity.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

// ponytail: compiled sibling of the module under test.
const s: typeof import('../src/data/sensitivity') = require('../src/data/sensitivity');

type Col = { name: string; type: 'text' | 'number' | 'date' };
const text = (name: string): Col => ({ name, type: 'text' });
const num = (name: string): Col => ({ name, type: 'number' });
/** Detect over one column of values. */
function one(col: Col, values: (string | number | null)[]) {
  return s.detectSensitive([col], values.map((v) => [v]))[0] || null;
}

// ── Cards: Luhn ─────────────────────────────────────────────────────────────
const CARDS = ['4111 1111 1111 1111', '5555-5555-5555-4444', '378282246310005', '6011111111111117', '4012888888881881'];
ok('Luhn: the standard test numbers are valid', CARDS.every((c) => s.isCardNumber(c)), CARDS.filter((c) => !s.isCardNumber(c)).join());
ok('Luhn: one digit off is invalid', !s.isCardNumber('4111 1111 1111 1112') && !s.isCardNumber('5555555555554445'));
ok('Luhn: all zeros passes the arithmetic but is refused', !s.isCardNumber('0000 0000 0000 0000'));
ok('Luhn: too short / too long / letters are not cards',
  !s.isCardNumber('4111 1111 11') && !s.isCardNumber('41111111111111111111111') && !s.isCardNumber('4111-1111-ABCD-1111'));
const cardCol = one(text('payment'), CARDS);
ok('a column of valid cards is proposed FINANCIAL / card_number', !!cardCol && cardCol.level === 'financial' && cardCol.kind === 'card_number', JSON.stringify(cardCol));
ok('…with a reason that says why', !!cardCol && /5 of 5 sampled values/.test(cardCol.reason) && /Luhn/.test(cardCol.reason), cardCol && cardCol.reason);
// Random 16-digit order ids pass Luhn about one time in ten — never a majority.
const orderIds = ['1234567812345678', '9876543219876543', '1111222233334444', '5555666677778888', '1029384756102938', '1357924680135792'];
ok('order ids that are not Luhn-valid are NOT proposed', one(text('order_id'), orderIds) === null);

// ── IBAN: mod-97 ────────────────────────────────────────────────────────────
const IBANS = ['GB82 WEST 1234 5698 7654 32', 'DE89370400440532013000', 'FR1420041010050500013M02606', 'NL91ABNA0417164300'];
ok('mod-97: real-format IBANs are valid', IBANS.every((v) => s.isIban(v)), IBANS.filter((v) => !s.isIban(v)).join());
ok('mod-97: one character off is invalid', !s.isIban('GB82 WEST 1234 5698 7654 33') && !s.isIban('DE89370400440532013001'));
ok('an IBAN-shaped product code is not an IBAN', !s.isIban('AB12CDEFGHIJKLMNOP'));
const ibanCol = one(text('account'), IBANS);
ok('a column of IBANs is proposed FINANCIAL / iban', !!ibanCol && ibanCol.kind === 'iban' && ibanCol.level === 'financial', JSON.stringify(ibanCol));

// ── Email ───────────────────────────────────────────────────────────────────
ok('emails match', s.isEmail('jane.doe+tag@example.co.uk') && s.isEmail('X@Y.IO'));
ok('not-quite-emails do not', !s.isEmail('jane@localhost') && !s.isEmail('@example.com') && !s.isEmail('jane doe@example.com') && !s.isEmail('a@b.c'));
const emailCol = one(text('contact'), ['a@example.com', 'b@example.org', 'c@mail.example.net', null, '']);
ok('an email column is proposed PERSONAL / email (empties ignored)', !!emailCol && emailCol.kind === 'email' && emailCol.level === 'personal' && /3 of 3/.test(emailCol.reason), JSON.stringify(emailCol));
ok('one email in a notes column is NOT an email column',
  one(text('notes'), ['call back', 'sent to a@example.com', 'ok', 'fine', 'left voicemail']) === null);
// The header is only a HINT for email: `email_sent` is a yes/no column.
ok('`email_sent` (yes/no) is NOT proposed on its name alone', one(text('email_sent'), ['yes', 'no', 'yes', 'no']) === null);
ok('`email` with a minority of addresses IS proposed (hint lowers the bar)',
  (one(text('email'), ['a@example.com', 'b@example.com', 'n/a', 'unknown', 'none'])?.kind) === 'email');

// ── Phone ───────────────────────────────────────────────────────────────────
const PHONES = ['+1 415 555 0132', '(415) 555-0199', '020 7946 0958', '+44 20 7946 0958', '415.555.0100 x12'];
ok('phone numbers match', PHONES.every((p) => s.isPhone(p)), PHONES.filter((p) => !s.isPhone(p)).join());
const NOT_PHONES = ['2024-01-15', '12/31/2024', '2019-2020', '94107-1234', '1234567.89', '4155550100', '12', '1.2.3.4'];
ok('dates, year ranges, ZIP+4, decimals and bare numbers are NOT phones',
  NOT_PHONES.every((p) => !s.isPhone(p)), NOT_PHONES.filter((p) => s.isPhone(p)).join());
ok('a phone column is proposed PERSONAL / phone', (one(text('tel'), PHONES)?.kind) === 'phone');
ok('a date column is NOT proposed as phones', one(text('when'), ['2024-01-15', '2024-02-01', '2023-12-31', '2024-03-09']) === null);

// ── National id ─────────────────────────────────────────────────────────────
ok('SSNs and NINOs match', s.isNationalId('123-45-6789') && s.isNationalId('AB 12 34 56 C') && s.isNationalId('JG103759A'));
ok('never-issued SSNs do not', !s.isNationalId('000-12-3456') && !s.isNationalId('666-12-3456') && !s.isNationalId('923-45-6789') && !s.isNationalId('123-00-6789'));
const ssnCol = one(text('ref'), ['123-45-6789', '234-56-7890', '345-67-8901']);
ok('an SSN column is national_id, not phone (most specific rule first)', !!ssnCol && ssnCol.kind === 'national_id', JSON.stringify(ssnCol));
ok('`passport_no` is proposed on its NAME alone', (one(text('passport_no'), ['X1', 'X2', 'X3'])?.kind) === 'national_id');

// ── IP vs version strings ───────────────────────────────────────────────────
ok('IPv4 and IPv6 match', s.isIp('192.168.1.20') === 4 && s.isIp('2001:db8::8a2e:370:7334') === 6 && s.isIp('::1') === 6);
ok('non-IPs do not', s.isIp('256.1.1.1') === 0 && s.isIp('1.2.3') === 0 && s.isIp('1.2.3.4-beta') === 0 && s.isIp('12:30:45') === 0 && s.isIp('00:1A:2B:3C:4D:5E') === 0);
ok('an IP column is proposed PERSONAL / ip_address',
  (one(text('client'), ['192.168.1.20', '10.0.0.254', '172.16.4.1', '203.0.113.9'])?.kind) === 'ip_address');
ok('a column of 1.2.3.4-style version numbers is NOT an IP column',
  one(text('tag'), ['1.2.3.4', '1.2.3.5', '2.0.0.1', '1.10.2.3']) === null);
ok('…and a `version` header is never an IP hint', one(text('app_version'), ['10.0.0.1', '10.0.0.2', '10.0.1.0']) === null);
ok('…but an `ip` header takes small octets at their word', (one(text('ip'), ['1.2.3.4', '1.2.3.5', '2.0.0.1'])?.kind) === 'ip_address');

// ── Street addresses ────────────────────────────────────────────────────────
const ADDRS = ['221B Baker Street', '1600 Pennsylvania Avenue NW', '10 Downing St', 'Hauptstraße 12', '12 rue de Rivoli', 'Calle Mayor 3', 'Keizersgracht 123'];
ok('street addresses match (EN and EU forms)', ADDRS.every((a) => s.isStreetAddress(a)), ADDRS.filter((a) => !s.isStreetAddress(a)).join(' | '));
const NOT_ADDRS = ['3 Way Plug', 'Main Street', 'Rue de Rivoli', 'Q3 revenue', '5 Court'];
ok('things with street words but no address shape do not', NOT_ADDRS.every((a) => !s.isStreetAddress(a)), NOT_ADDRS.filter((a) => s.isStreetAddress(a)).join(' | '));
ok('an address column is proposed PERSONAL / street_address', (one(text('where'), ADDRS)?.kind) === 'street_address');

// ── Person names, through the bundled first-name list ───────────────────────
ok('the bundled list loaded (a couple of thousand names)', s.firstNameSet().size > 2000, String(s.firstNameSet().size));
ok('names across locales are in it', ['grace', 'jose', 'mehmet', 'priya', 'yuki', 'olga', 'kwame', 'soren'].every((n) => s.firstNameSet().has(n)));
ok('month and place words are NOT in it', !['may', 'june', 'london', 'paris', 'hope'].some((n) => s.firstNameSet().has(n)));
ok('"Grace Hopper", "Hopper, Grace", "María José García", "O\'Brien, Liam" are names',
  s.isPersonName('Grace Hopper') && s.isPersonName('Hopper, Grace') && s.isPersonName('María José García') && s.isPersonName("O'Brien, Liam"));
ok('ordinary capitalised words are not', !s.isPersonName('Blue Widget') && !s.isPersonName('North Region') && !s.isPersonName('May Sales') && !s.isPersonName('Grace') && !s.isPersonName('grace hopper'));
const people = ['Grace Hopper', 'Alan Turing', 'Ada Lovelace', 'Katherine Johnson', 'Linus Torvalds'];
ok('a names column is proposed PERSONAL / person_name', (one(text('who'), people)?.kind) === 'person_name');
ok('a product column is NOT', one(text('product'), ['Blue Widget', 'Red Gadget', 'Steel Frame', 'Oak Table', 'Glass Jar']) === null);
ok('`customer_name` is proposed on its NAME alone', (one(text('customer_name'), ['ACME-1', 'ACME-2', 'ACME-3'])?.kind) === 'person_name');
ok('`product_name` / `file_name` are not', one(text('product_name'), ['A1', 'B2', 'C3']) === null && one(text('file_name'), ['a.csv', 'b.csv', 'c.csv']) === null);

// ── Header-only kinds and tokenising ────────────────────────────────────────
ok('headers tokenise camelCase and punctuation', JSON.stringify(s.headerTokens('customerEmail_Addr')) === JSON.stringify(['customer', 'email', 'addr']));
ok('`salary` is proposed FINANCIAL on its name; `revenue` is not',
  (one(num('salary'), [50000, 62000, 71000])?.level) === 'financial' && one(num('revenue'), [50000, 62000, 71000]) === null);
ok('`date_of_birth` / `DOB` are proposed PERSONAL', (one(text('date_of_birth'), ['1990-01-01', '1985-06-30', '2001-12-12'])?.kind) === 'birth_date'
  && (one(text('DOB'), ['1990-01-01', '1985-06-30', '2001-12-12'])?.kind) === 'birth_date');
ok('`card_number` with no values yet is still proposed', (one(text('card_number'), [])?.kind) === 'card_number');

// ── The table-level call ────────────────────────────────────────────────────
const table = s.detectSensitive(
  [text('id'), text('email'), text('city'), num('amount'), text('card')],
  [['1', 'a@example.com', 'Paris', 10, '4111111111111111'],
    ['2', 'b@example.com', 'Rome', 20, '5555555555554444'],
    ['3', 'c@example.com', 'Oslo', 30, '378282246310005']],
);
ok('a mixed table proposes exactly email and card, in column order',
  JSON.stringify(table.map((p) => [p.column, p.kind])) === JSON.stringify([['email', 'email'], ['card', 'card_number']]), JSON.stringify(table));
ok('detection never throws on ragged or empty input',
  s.detectSensitive([text('a'), text('b')], [[null], [], ['x', 'y', 'z']]).length === 0 && s.detectSensitive([], []).length === 0);
// Only a SAMPLE is read: a million-row table costs the same as a small one.
const big: (string | null)[][] = Array.from({ length: 50_000 }, (_, i) => [`u${i}@example.com`]);
const t0 = Date.now();
const bigHit = s.detectSensitive([text('email')], big);
ok('a 50,000-row column is sampled, not scanned', bigHit.length === 1 && Date.now() - t0 < 500, `${Date.now() - t0} ms`);

finish();
