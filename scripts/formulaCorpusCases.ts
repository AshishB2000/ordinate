// The formula golden's FIXED edge cases: the first entries of the corpus
// (scripts/formulaCorpus.ts). Hand-picked where a change to the parser is most
// likely to slip: IN binding before the comparison loop, precedence, unary
// signs, keyword case, LOD shapes and nesting, error positions, and every
// date-text shape toDate reads. The corpus is pinned string for string by the
// golden, so this list is frozen with it: never edit it, add cases elsewhere.

const HAND: string[] = [
  // IN binds once, before the comparison loop
  "a IN (1) = TRUE", "[n] IN (0) = TRUE", "[n] IN (3, 0) = [u]", "1 IN (1, 2) = 1", "'a' IN ('a') != FALSE", "[t] IN () = FALSE",
  "[n] IN (NULL)", "NULL IN (NULL)", "[n] IN ([m], 1e21)", "NOT [n] IN (3)", "[n] + 1 IN (4)", "[n] IN (3) AND [m] IN (7)",
  "[n] IN (3) IN (TRUE)", "[u] in ('true', 'TRUE') = 1", "[t] IN ('007', 7)", "[d] In ([d])", "[n] IN (3) = TRUE = TRUE",
  "[n] IN (1 = 1)", "[n] IN (0) < 1",
  // signs and arithmetic
  "-[n] * [m]", "+[n]", "-(-[n])", "- -[n]", "--2.5", "-[t]", "+[t]", "-0", "0 * -1", "-[n] % 2", "[n] % 0", "[n] / 0", "1 / [m]",
  "[m] / [n]", "7 % -2", "-7 % 2", "2.5 % 1", "1e21 + 1", "1e21 * 1e21 * 1e300", "9007199254740992 + 1", "0.1 + 0.2", "0.5 - 0.5",
  "1 - 2 - 3", "2 * 3 % 4", "8 / 2 / 2", "1 + 2 * 3", "(1 + 2) * 3", ".5 + 1", "1.e5", "1e", "1e+2 - 1E-2", "[n] - -[m]", "-[n] ^ 2",
  // grouping and names
  "((1))", "(((([n]))))", "[x y]", "[ x y ]", "[x y] = [t]", "n + m", "N + M", "[N]", "missing", "[missing] + 1", "_n", "[]",
  // literals
  "''", "' '", "'ß'", "'ΑΣ'", "'2024-02-29'", '"double"', "'it\\'s'", "'\\\\'", "TRUE", "true", "False", "NULL", "nUlL", "007", "0.50",
  // truthiness and logic
  "TRUE AND NULL", "NULL OR 0", "NOT NULL", "NOT ''", "NOT ' '", "NOT 0.0", "NOT -0", "[t] AND [u]", "[t] OR [n]", "NOT NOT [n]",
  "[n] AND [m] OR [t]", "[n] OR [m] AND [t]", "NOT [n] = 0", "not [n] and [m]", "[n] > 0 or [t] = 'abc' and [u] = 'true'",
  // comparisons
  "'10' > '9'", "10 > 9", "'10' > 9", "NULL = NULL", "NULL != NULL", "NULL < 1", "NULL >= NULL", "'' = NULL", "'' < NULL", "[n] == -0",
  "0 = -0", "'007' = 7", "'7' = 7", "[u] = TRUE", "TRUE = 'true'", "TRUE = 1", "1 = 1 = 1", "1 < 2 < 3", "3 > 2 > 1",
  "[d] > '2024-01-01'", "[t] < [u]", "'ß' > 'z'", "'ΑΣ' <= 'αΣ'", "[n] != [m]", "[n] <= [m]", "[m] = [n]", "[t] == [t]",
  // parameters
  "[[p]]", "[[p]] + 1", "[[p]] IN (NULL)", "[[ p ]]", "[[p]] = NULL", "IF [[p]] THEN 1 ELSE 2 END", "round([[p]])",
  // IF and CASE
  "IF [n] > 0 THEN 'pos' ELSEIF [n] < 0 THEN 'neg' ELSE 'zero' END", "if [n] then 1 end", "If [t] Then 1 ElseIf [u] Then 2 eLsE 3 EnD",
  "IF ([n] > 1) THEN 1 END", "if([n], 1, 2)", "IF([n] > 0, 'y')", "iif([n] > 0, 'y', 'n', 'u')", "iif(NULL, 1, 2, 3)", "iif(1, 2)",
  "CASE [t] WHEN 'abc' THEN 1 WHEN '007' THEN 2 ELSE 3 END", "CASE [n] WHEN 0 THEN 'zero' END", "case [u] when 'true' then TRUE end",
  "CASE NULL WHEN NULL THEN 1 END", "CASE [n] WHEN '0' THEN 1 ELSE 0 END", "CASE [n] + 1 WHEN 1 THEN 'one' WHEN 4 THEN 'four' END",
  "IF IF [n] THEN 1 END THEN 2 END", "CASE CASE [n] WHEN 3 THEN 1 END WHEN 1 THEN 'x' END", "IF [n] THEN 1 ELSE IF [m] THEN 2 END END",
  "IF [n] THEN 1 ELSEIF [m] THEN 2 ELSEIF [t] THEN 3 END", "CaSe [x y] WhEn 'a' ThEn 1 EnD",
  // functions at their edges
  "round(-2.5)", "round(2.5)", "round(-0.5)", "round(0.5)", "round(1.005, 2)", "round([n], 1)", "round([n], -1)", "round(1e21)",
  "ROUND(-2.5)", "Round(2.5, 0)", "int(-2.5)", "int([t])", "int('12')", "float([u])", "float('1e3')", "str([n])", "str(-0)",
  "str(1e21)", "str(0.1 + 0.2)", "str(TRUE)", "zn([n])", "zn([t])", "div(7, -2)", "div(-7, 2)", "div(1, 0)", "power(-8, 1/3)",
  "power(2, 0.5)", "log(8, 2)", "log(-1)", "log(100)", "sqrt(-1)", "ln(0)", "exp(1000)", "abs(-0)", "sign(-0)", "min()",
  "max([t], [u])", "min([n], [m])", "max(1, 'a')", "min(NULL, 1)", "max('2024-01-01', '2023-12-31')", "atan2(1, 0)", "pi()",
  "degrees(pi())", "cot(0)", "len('ΑΣ')", "len('ß')", "lower('ΑΣ')", "upper('ß')", "proper('hello wORLD')", "proper([t])",
  "left([t], -1)", "left([t], 2)", "right([t], 2)", "mid([t], 0)", "mid('abcdef', 2, 3)", "mid('abcdef', -1, 2)", "find([t], '')",
  "find('abcabc', 'c', 4)", "findnth('a.b.c', '.', 2)", "findnth('a.b.c', '.', 0)", "replace([t], '', 'x')", "replace('aaa', 'a', 'bb')",
  "split('a,b,c', ',', -1)", "split('a,b,c', ',', 2)", "split([t], '', 1)", "contains([t], '')", "startswith([u], '0')",
  "endswith([u], 'e')", "trim([u])", "ltrim(' x ')", "rtrim(' x ')", "ascii('')", "ascii('ß')", "char(65)", "char(-1)", "space(3)",
  "space(-1)", "concat([t], [n], [u])", "concat()", "concat(NULL, 'a')", "ifnull([n], 'none')", "isnull([t])",
  "coalesce(NULL, [n], [m])", "coalesce()", "regexp_match([t], '^a')", "regexp_match([t], '(')", "regexp_match('ΑΣ', '\\\\w')",
  "regexp_extract('abc123', '([0-9]+)')", "regexp_extract('abc', '(x)')", "regexp_extract_nth('a1b2', '([a-z])([0-9])', 2)",
  "regexp_replace([t], 'b', 'X')", "regexp_replace([u], '\\\\s+', '')", "regexp_replace('aaa', 'a*', '-')",
  "distance_km(0, 0, 0, 1)", "distance_km(91, 0, 0, 0)", "makedate(2024, 2, 29)", "makedate(2023, 2, 29)", "maketime(25, 0, 0)",
  "makedatetime('2024-02-29', '23:59:59')", "makedatetime([d], [d])", "ceiling(-0.5)", "floor(-0.5)", "square([n])",
  // LOD shapes
  "{FIXED : SUM([n])}", "{fixed: sum([n])}", "{ FIXED [t] : SUM([n]) }", "{FIXED [t], [u] : AVG([m])}", "{FIXED [t], [t] : SUM([n])}",
  "{FIXED t, u : SUM(n)}", "{FIXED [x y] : MAX([d])}", "{FIXED [t] : MIN([d])}", "{INCLUDE [t] : COUNT([u])}",
  "{EXCLUDE [t] : COUNTD([u])}", "{FIXED [zz] : SUM([n])}", "{FIXED [t] : SUM([n] * 2)}", "{FIXED [t] : SUM(TRUE)}",
  "{FIXED [t] : SUM(n)}", "{FIXED : COUNTD([d])}", "{FIXED [t] : SUM({FIXED : MAX([n])})}",
  "{FIXED [u] : AVG([n] - {FIXED [t] : AVG([n])})}", "[n] - {EXCLUDE [t] : AVG([n])}", "{FIXED : SUM([n])} + {FIXED : SUM([m])}",
  "IF {FIXED [t] : COUNT([n])} > 1 THEN 'many' ELSE 'one' END", "{FIXED [t] : SUM({FIXED [t] : SUM({FIXED : SUM([n])})})}",
  "{FIXED : SUM([[p]])}", "{fixed [t] : countd(lower([t]))}", "{FIXED [x y] : SUM({FIXED [t] : COUNT([n])} + {FIXED : MIN([m])})}",
  "{FIXED [t] : MAX([n] IN (3) = TRUE)}", "{FIXED [x y] : COUNTD([n])}", "{FIXED [x y] : AVG([m])} / {FIXED : AVG([m])}",
  // malformed, each with its position
  "", " ", "1;process.exit", "[n] +", "[n] /  ", "* 2", "( 1", "1 )", "round(", "sum([n])", "avg([n])", "count(1)", "foo()", "[n",
  "'abc", '"abc', "[[p", "{FIXED [t] SUM([n])}", "{FIXED [t] : SUM([n])", "{ROWS : SUM([n])}", "{FIXED : MEDIAN([n])}",
  "{FIXED : SUM([n]) + 1}", "{FIXED 1 : SUM([n])}", "{FIXED [t], : SUM([n])}", "{}", "{FIXED}", "SUM({FIXED : SUM([n])})",
  "{FIXED : SUM()}", "1 2", "[n] [m]", "IF [n] THEN 1 ELSE 2", "IF [n] 1 END", "CASE [t] END", "CASE WHEN 1 THEN 2 END",
  "IF THEN END", "@", "#", "$x", "1 = = 2", "AND", "NOT", "IN (1)", "(", ")", ",", ":", "}", "1 IN 1", "1 IN (1,)", "1 IN (,1)",
  "round(1,)", "round(,1)", "Round (1)", "ROUND\n(\n1\n)", "[n] +\n", "[n]\t*\t", "1 +  ", "elseif", "end", "then 1", "[n] ELSE",
  "{FIXED [t] : SUM([n])} }", "1 ! 2", "1 <> 2", "1 & 2", "'a' || 'b'", "[n] IN (1", "IF [n] THEN END", "{FIXED [t] : SUM([n]) ",
  "{FIXED [t] : SUM([n]),}", "{FIXED [t] : SUM([n], [m])}", "{fixed [t] : sum[n]}", "CASE [n] WHEN 1 2 END", "if [n] then 1 else 2 end end",
];

// Precedence and associativity: every ordered pair of binary operators.
const OPERANDS = ['[n]', '[m]', '[u]', '2.5', "'007'"];
const BINARY = ['+', '-', '*', '/', '%', '=', '!=', '<', '>=', 'AND', 'OR'];
const PRECEDENCE = BINARY.flatMap((a, i) =>
  BINARY.map((b, j) => `${OPERANDS[i % 5]} ${a} ${OPERANDS[j % 5]} ${b} ${OPERANDS[(i + j) % 5]}`));

// Every one-date function over every date-text shape toDate reads, and some it does not.
const DATE_FNS = ['year', 'month', 'day', 'quarter', 'week', 'isoweek', 'isoyear', 'isoquarter', 'isoweekday', 'date', 'datetime', 'isdate'];
const DATE_ARGS = ['[d]', '[t]', '[u]', "'2024-02-29'", "'2024/2/29 23:59'", "'02/29/2024'", "'2024-13-45'", "'2021-01-03T04:05:06'", '[n]'];
const DATES = DATE_FNS.flatMap((f) => DATE_ARGS.map((a) => `${f}(${a})`));

// Every date part through every part-taking function.
const PARTS = ["'year'", "'quarter'", "'month'", "'week'", "'day'", "'weekday'", "'dayofyear'", "'hour'", "'minute'", "'second'", "'iso-week'", "'bogus'", '[t]'];
const DATE_PARTS = PARTS.flatMap((p) => [`datepart(${p}, [d])`, `datename(${p}, [d])`, `datetrunc(${p}, [d])`,
  `dateadd(${p}, 1, [d])`, `dateadd(${p}, -1.5, '2024-01-31')`, `datediff(${p}, [d], '2024-03-01 12:00')`]);

// Every LOD kind × aggregate × dimension set.
const LOD_KINDS = ['FIXED', 'include', 'Exclude'];
const LOD_AGGS = ['SUM', 'avg', 'Min', 'MAX', 'count', 'COUNTD'];
const LOD_DIMS = ['', '[t]', '[t], [x y]'];
const LOD_ARGS = ['[n]', '[t]', '[d]', '[n] * 2', 'n', '[u]'];
const LODS = LOD_KINDS.flatMap((k, i) => LOD_AGGS.flatMap((a, j) =>
  LOD_DIMS.map((d, l) => `{${k} ${d} : ${a}(${LOD_ARGS[(i + j + l) % LOD_ARGS.length]})}`)));

export const FIXED_CASES: readonly string[] = [...HAND, ...PRECEDENCE, ...DATES, ...DATE_PARTS, ...LODS];
