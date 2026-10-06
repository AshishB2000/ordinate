// What each formula function IS — MAIN PROCESS, PURE data. No fs,
// no DOM, and deliberately no reference to the implementations themselves: this
// is a catalog the formula editor's function list reads, not a second copy of
// the evaluator.
//
// ONE ENTRY PER KEY IN `FUNCTIONS` (formulaEval.ts), and
// scripts/test-formulaDocs.ts asserts the two key sets are IDENTICAL — not a
// subset either way. That is the whole point of the file. The old calculated-
// field form documented the language in a one-line hint that named four
// functions out of eighty-two; everything else was undiscoverable unless you
// already knew Tableau. A catalog that main OWNS and a test that fails when it
// falls behind means a function cannot ship without a name, a shape and an
// example the user can read.
//
// The same test COMPILES every `example`, so the examples cannot rot into
// something that no longer parses. They reference made-up column names on
// purpose: an unknown column is a runtime `null` here, never a compile error
// (see formula.ts), so the example stays valid against any dataset.
//
// SIGNATURE CONVENTION: a trailing `?` marks an optional argument — `mid(text,
// start, length?)`. Tableau's own docs bracket optional arguments, which cannot
// work here: `[length]` is a COLUMN REFERENCE in this language, so a bracketed
// argument in a signature reads as data rather than as syntax.

export type FunctionCategory = 'number' | 'string' | 'date' | 'logical' | 'conversion' | 'lod';

export interface FunctionDoc {
  /** The name as written in an expression — the key in `FUNCTIONS`. */
  name: string;
  category: FunctionCategory;
  /** The call shape, e.g. `round(number, decimals?)`. */
  signature: string;
  /** One sentence. Shown on hover in the editor's function list. */
  summary: string;
  /** A COMPILABLE expression — asserted by scripts/test-formulaDocs.ts. */
  example: string;
  /** r7:lod — what a click inserts when it is not `name(`, and what kind of entry it is. */
  insert?: string;
  kind?: 'keyword' | 'recipe';
}

type Entry = Omit<FunctionDoc, 'name'>;

// Five builders instead of a `category:` line per entry — 82 entries times four
// keys is a wall of punctuation nobody proof-reads, and the shape it hides is
// just "this one is a string function".
const n = (signature: string, summary: string, example: string): Entry => ({ category: 'number', signature, summary, example });
const s = (signature: string, summary: string, example: string): Entry => ({ category: 'string', signature, summary, example });
const d = (signature: string, summary: string, example: string): Entry => ({ category: 'date', signature, summary, example });
const l = (signature: string, summary: string, example: string): Entry => ({ category: 'logical', signature, summary, example });
const c = (signature: string, summary: string, example: string): Entry => ({ category: 'conversion', signature, summary, example });

const RAW: Record<string, Entry> = {
  // ── Number ─────────────────────────────────────────────────────────────────
  round: n('round(number, decimals?)', 'Rounds to the given number of decimal places (0 by default).', 'round([price], 2)'),
  abs: n('abs(number)', 'The absolute value, dropping the sign.', 'abs([balance])'),
  floor: n('floor(number)', 'Rounds down to the nearest whole number.', 'floor([score])'),
  ceil: n('ceil(number)', 'Rounds up to the nearest whole number.', 'ceil([score])'),
  ceiling: n('ceiling(number)', 'Rounds up to the nearest whole number (Tableau’s name for ceil).', 'ceiling([score])'),
  sign: n('sign(number)', 'Returns -1, 0 or 1 for a negative, zero or positive number.', 'sign([profit])'),
  sqrt: n('sqrt(number)', 'The square root. A negative input yields null.', 'sqrt([area])'),
  square: n('square(number)', 'The number multiplied by itself.', 'square([side])'),
  exp: n('exp(number)', 'e raised to the given power.', 'exp([rate])'),
  ln: n('ln(number)', 'The natural logarithm. Zero or negative yields null.', 'ln([revenue])'),
  sin: n('sin(radians)', 'The sine of an angle given in radians.', 'sin(radians([angle]))'),
  cos: n('cos(radians)', 'The cosine of an angle given in radians.', 'cos(radians([angle]))'),
  tan: n('tan(radians)', 'The tangent of an angle given in radians.', 'tan(radians([angle]))'),
  asin: n('asin(number)', 'The arcsine, in radians.', 'asin([ratio])'),
  acos: n('acos(number)', 'The arccosine, in radians.', 'acos([ratio])'),
  atan: n('atan(number)', 'The arctangent, in radians.', 'atan([slope])'),
  cot: n('cot(radians)', 'The cotangent of an angle given in radians.', 'cot(radians([angle]))'),
  degrees: n('degrees(radians)', 'Converts radians to degrees.', 'degrees([angle])'),
  radians: n('radians(degrees)', 'Converts degrees to radians.', 'radians([angle])'),
  pi: n('pi()', 'The constant π.', 'pi() * square([radius])'),
  atan2: n('atan2(y, x)', 'The arctangent of y/x, in radians, using the signs to pick the quadrant.', 'atan2([dy], [dx])'),
  power: n('power(number, exponent)', 'Raises a number to a power.', 'power([base], 3)'),
  log: n('log(number, base?)', 'The logarithm, base 10 unless another base is given.', 'log([views], 2)'),
  div: n('div(numerator, denominator)', 'Integer division, truncated towards zero. Dividing by zero yields null.', 'div([total], [count])'),
  zn: n('zn(number)', 'The number, or 0 when it is null or not numeric.', 'zn([discount])'),
  min: n('min(a, b, …)', 'The smallest argument — numeric when all are numbers, otherwise compared as text.', 'min([list_price], [sale_price])'),
  max: n('max(a, b, …)', 'The largest argument — numeric when all are numbers, otherwise compared as text.', 'max([list_price], [sale_price])'),

  // ── String ─────────────────────────────────────────────────────────────────
  lower: s('lower(text)', 'Converts the text to lower case.', 'lower([email])'),
  upper: s('upper(text)', 'Converts the text to upper case.', 'upper([code])'),
  trim: s('trim(text)', 'Removes leading and trailing whitespace.', 'trim([name])'),
  ltrim: s('ltrim(text)', 'Removes leading whitespace.', 'ltrim([name])'),
  rtrim: s('rtrim(text)', 'Removes trailing whitespace.', 'rtrim([name])'),
  len: s('len(text)', 'The number of characters in the text.', 'len([description])'),
  proper: s('proper(text)', 'Capitalises the first letter of each word and lower-cases the rest.', 'proper([city])'),
  ascii: s('ascii(text)', 'The character code of the first character.', 'ascii([grade])'),
  char: s('char(code)', 'The character with the given character code.', 'char(65)'),
  space: s('space(count)', 'A run of the given number of spaces.', 'concat([first], space(1), [last])'),
  contains: s('contains(text, substring)', 'True when the text contains the substring.', 'contains([notes], "urgent")'),
  startswith: s('startswith(text, prefix)', 'True when the text begins with the prefix.', 'startswith([sku], "AB")'),
  endswith: s('endswith(text, suffix)', 'True when the text ends with the suffix.', 'endswith([file], ".csv")'),
  left: s('left(text, count)', 'The first `count` characters.', 'left([postcode], 3)'),
  right: s('right(text, count)', 'The last `count` characters.', 'right([phone], 4)'),
  mid: s('mid(text, start, length?)', 'Characters from `start` (1-based) onwards, optionally capped at `length`.', 'mid([sku], 3, 4)'),
  find: s('find(text, substring, start?)', 'The 1-based position of the substring, or 0 when it is absent.', 'find([email], "@")'),
  findnth: s('findnth(text, substring, n)', 'The 1-based position of the nth occurrence, or 0 when there is none.', 'findnth([path], "/", 2)'),
  replace: s('replace(text, find, replacement)', 'Replaces every literal occurrence of `find`.', 'replace([phone], "-", "")'),
  split: s('split(text, delimiter, n)', 'The nth piece after splitting; a negative n counts from the end.', 'split([full_name], " ", 1)'),
  regexp_match: s('regexp_match(text, pattern)', 'True when the regular expression matches anywhere in the text.', 'regexp_match([sku], "^[A-Z]{2}")'),
  regexp_extract: s('regexp_extract(text, pattern)', 'The first capture group, or the whole match when the pattern has no group.', 'regexp_extract([url], "https?://([^/]+)")'),
  regexp_extract_nth: s('regexp_extract_nth(text, pattern, n)', 'The nth capture group — 0 is the whole match.', 'regexp_extract_nth([stamp], "(\\\\d+)-(\\\\d+)", 2)'),
  regexp_replace: s('regexp_replace(text, pattern, replacement)', 'Replaces every regular-expression match.', 'regexp_replace([note], "\\\\s+", " ")'),
  concat: s('concat(a, b, …)', 'Joins every argument into one string; nulls contribute nothing.', 'concat([first], " ", [last])'),

  // ── Date ───────────────────────────────────────────────────────────────────
  year: d('year(date)', 'The four-digit year.', 'year([ordered_at])'),
  month: d('month(date)', 'The month as 1–12.', 'month([ordered_at])'),
  day: d('day(date)', 'The day of the month as 1–31.', 'day([ordered_at])'),
  quarter: d('quarter(date)', 'The calendar quarter as 1–4.', 'quarter([ordered_at])'),
  week: d('week(date)', 'The week of the year, counting from the first Sunday.', 'week([ordered_at])'),
  isoweek: d('isoweek(date)', 'The ISO-8601 week number, 1–53.', 'isoweek([ordered_at])'),
  isoyear: d('isoyear(date)', 'The ISO-8601 week-numbering year, which can differ from the calendar year in January and December.', 'isoyear([ordered_at])'),
  isoquarter: d('isoquarter(date)', 'The quarter as 1–4.', 'isoquarter([ordered_at])'),
  isoweekday: d('isoweekday(date)', 'The weekday as 1–7, Monday being 1.', 'isoweekday([ordered_at])'),
  datepart: d('datepart(part, date)', 'One numeric component — "year", "month", "day", "hour", "minute", "second" and friends.', 'datepart("month", [ordered_at])'),
  datename: d('datename(part, date)', 'One component as a NAME, e.g. "March" or "Tuesday".', 'datename("month", [ordered_at])'),
  datediff: d('datediff(part, start, end)', 'Whole `part` units from start to end.', 'datediff("day", [ordered_at], [shipped_at])'),
  dateadd: d('dateadd(part, amount, date)', 'Shifts the date by `amount` units of `part`.', 'dateadd("month", 1, [ordered_at])'),
  datetrunc: d('datetrunc(part, date)', 'Rounds the date down to the start of that unit.', 'datetrunc("month", [ordered_at])'),
  makedate: d('makedate(year, month, day)', 'Builds a date from three numbers.', 'makedate(2026, 1, 31)'),
  maketime: d('maketime(hour, minute, second)', 'Builds a time from three numbers.', 'maketime(9, 30, 0)'),
  makedatetime: d('makedatetime(date, time)', 'Combines a date and a time into one timestamp.', 'makedatetime([ordered_at], [ordered_time])'),
  now: d('now()', 'The current date and time.', 'datediff("day", [ordered_at], now())'),
  today: d('today()', 'The current date, with no time part.', 'datediff("day", [ordered_at], today())'),
  isdate: d('isdate(value)', 'True when the value can be read as a date.', 'isdate([raw_date])'),

  // ── Type conversion ────────────────────────────────────────────────────────
  date: c('date(value)', 'Reads the value as a date and returns it as YYYY-MM-DD.', 'date([raw_date])'),
  datetime: c('datetime(value)', 'Reads the value as a timestamp and returns it as YYYY-MM-DD HH:MM:SS.', 'datetime([raw_stamp])'),
  int: c('int(value)', 'Converts to a whole number, truncating towards zero.', 'int([quantity])'),
  float: c('float(value)', 'Converts to a decimal number.', 'float([amount])'),
  str: c('str(value)', 'Converts the value to text.', 'str([order_id])'),

  // ── Logical ────────────────────────────────────────────────────────────────
  if: l('if(condition, then, else)', 'The call form of IF. The keyword form — IF … THEN … ELSE … END — reads better for more than one branch.', 'if([score] > 90, "A", "B")'),
  iif: l('iif(condition, then, else, unknown?)', 'Like if(), with a fourth branch taken when the condition is null rather than false.', 'iif([active], "yes", "no", "unknown")'),
  ifnull: l('ifnull(value, fallback)', 'The value, or the fallback when it is null.', 'ifnull([discount], 0)'),
  isnull: l('isnull(value)', 'True when the value is null.', 'isnull([shipped_at])'),
  coalesce: l('coalesce(a, b, …)', 'The first argument that is not null.', 'coalesce([nickname], [first_name], "friend")'),

  // ── Geo (r6:geo) ───────────────────────────────────────────────────────────
  distance_km: n('distance_km(lat1, lon1, lat2, lon2)',
    'The great-circle distance in kilometres between two latitude/longitude points (haversine, mean Earth radius 6,371.0088 km). Null unless all four are coordinates.',
    'distance_km([store_lat], [store_lng], 30.2672, -97.7431)'),
};

/** The catalog, keyed exactly as `FUNCTIONS` is. */
export const FUNCTION_DOCS: Record<string, FunctionDoc> = Object.fromEntries(
  Object.entries(RAW).map(([name, e]) => [name, { name, ...e }]),
);

/** The catalog as a list, grouped by category in the order the editor shows them. */
export const FUNCTION_CATEGORIES: FunctionCategory[] = ['number', 'string', 'date', 'logical', 'conversion'];

/**
 * r7:lod — the level-of-detail catalog. NOT in `FUNCTION_DOCS`: FIXED, INCLUDE
 * and EXCLUDE are syntax, not `FUNCTIONS` keys, so the parity test above must
 * not see them. Three KEYWORD entries, then three RECIPES — whole expressions
 * worth copying, inserted as written. scripts/test-lod.ts compiles every
 * example. The recipes' columns are invented, like every example here.
 */
const lodEntry = (name: string, kind: 'keyword' | 'recipe', signature: string, summary: string, example: string, insert: string): FunctionDoc =>
  ({ name, category: 'lod', kind, signature, summary, example, insert });

export const LOD_DOCS: FunctionDoc[] = [
  lodEntry('fixed', 'keyword', '{FIXED [dim], … : AGG(expr)}',
    'Aggregates at exactly the named dimensions, whatever the visual shows. Ordinary filters leave it alone; a filter set to "Apply before LOD" narrows it.',
    '{FIXED [region] : SUM([sales])}', '{FIXED [] : SUM()}'),
  lodEntry('include', 'keyword', '{INCLUDE [dim], … : AGG(expr)}',
    'Aggregates at the visual’s dimensions plus these. Outside a visual it is FIXED on its own dimensions.',
    '{INCLUDE [customer] : SUM([sales])}', '{INCLUDE [] : SUM()}'),
  lodEntry('exclude', 'keyword', '{EXCLUDE [dim], … : AGG(expr)}',
    'Aggregates at the visual’s dimensions minus these. Outside a visual it is the whole table.',
    '{EXCLUDE [region] : SUM([sales])}', '{EXCLUDE [] : SUM()}'),
  lodEntry('share of region', 'recipe', 'Share of region',
    'Each row’s sales as a fraction of its whole region’s sales — sum it by region and every region reads 100%.',
    '[sales] / {FIXED [region] : SUM([sales])}', '[sales] / {FIXED [region] : SUM([sales])}'),
  lodEntry('first order date per customer', 'recipe', 'First order date per customer',
    'The earliest order date of each row’s customer, on every one of that customer’s rows — the cohort start.',
    '{FIXED [customer] : MIN([order_date])}', '{FIXED [customer] : MIN([order_date])}'),
  lodEntry('customers with more than 3 orders', 'recipe', 'Customers with more than 3 orders',
    'True on every row whose customer placed more than three distinct orders — use it as a filter or a dimension.',
    '{FIXED [customer] : COUNTD([order_id])} > 3', '{FIXED [customer] : COUNTD([order_id])} > 3'),
];

export function listFunctionDocs(): FunctionDoc[] {
  return FUNCTION_CATEGORIES.flatMap((cat) =>
    Object.values(FUNCTION_DOCS)
      .filter((doc) => doc.category === cat)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
}
