import { performance } from "node:perf_hooks";
import { matchPattern } from "../../packages/vinext/src/server/middleware-matcher.ts";
import {
  analyzeRegexSafety,
  analyzeSeparatedRepetitionSafety,
} from "../../packages/vinext/src/utils/regex-safety.ts";

const nearMiss = `/${"a/".repeat(2_000)}not-end`;
for (const modifier of ["*", "+"]) {
  // lgtm[js/redos] — deliberately hostile matcher executed in a timed child.
  const matcher = `/:path(.*)${modifier}/end`;
  if (!matchPattern(nearMiss, matcher)) {
    throw new Error(`Unsafe matcher did not fail closed: ${matcher}`);
  }
}

// Sequential repetitions that can consume the same text can also produce
// catastrophic backtracking without a quantifier directly wrapping a group.
const overlappingRepetition = "/:path(a+.*a+)";
if (!matchPattern(`/${"a".repeat(3_000)}b`, overlappingRepetition)) {
  throw new Error(`Unsafe matcher did not fail closed: ${overlappingRepetition}`);
}

// Alternations where one branch prefixes another have exponentially many
// partitions under an unbounded group repetition.
const ambiguousAlternative = "/:path((?:a|aa)+)";
if (!matchPattern(`/${"a".repeat(3_000)}b`, ambiguousAlternative)) {
  throw new Error(`Unsafe matcher did not fail closed: ${ambiguousAlternative}`);
}

for (const matcher of ["/:path((?:a+){10})", "/:path((?:a|A)+)"]) {
  if (!matchPattern(`/${"a".repeat(3_000)}b`, matcher)) {
    throw new Error(`Unsafe matcher did not fail closed: ${matcher}`);
  }
}

for (const matcher of [
  ...[6, 7, 8, 9, 10].map((count) => `/:path(${"(?:a+)".repeat(count)})`),
  ...[6, 7, 8].map((count) => `/:path(${"(?:a+(?:))".repeat(count)})`),
  ...[6, 8].map((count) => `/:path(${"(?:a+){1}".repeat(count)})`),
  ...[6, 8].map((count) => `/:path(${"(?:a+){1,1}".repeat(count)})`),
  `/:path(${"(?:a+){1}?".repeat(6)})`,
  ...[6, 8].map((count) => `/:path(${"(?:(?:a+){1}){1,1}".repeat(count)})`),
  `/:path(${"(?:a|aa)".repeat(26)})`,
]) {
  if (!matchPattern(`/${"a".repeat(3_000)}b`, matcher)) {
    throw new Error(`Unsafe bounded sequence did not fail closed: ${matcher}`);
  }
}

// A single overlapping boundary is kept for common two-repeat matchers, and
// non-overlapping repetitions do not compound the partition search.
for (const pattern of [
  "(?:a+)(?:a+)",
  "(?:a+(?:))(?:a+(?:))",
  "(?:a+){1}(?:a+){1,1}",
  "(?:a+){1}?(?:a+){1}",
  "(?:a+)(?:b+)(?:a+)",
  "(?:a+(?:))(?:b+(?:))(?:a+(?:))",
  "(?:(?:a+){1}){1,1}(?:b+){1}(?:(?:a+){1,1}){1}",
  "[^/]+.*",
]) {
  const issue = analyzeRegexSafety(pattern, { ignoreCase: true });
  if (issue) throw new Error(`Safe sequence was rejected: ${pattern} (${issue})`);
}
if (!matchPattern(`/${"a".repeat(3_000)}`, "/:path((?:a+)(?:a+))")) {
  throw new Error("Safe two-repeat matcher did not match");
}
if (matchPattern(`/${"a".repeat(3_000)}b`, "/:path((?:a+)(?:a+))")) {
  throw new Error("Safe two-repeat matcher matched a near miss");
}

// Keep the analysis itself linear for large, disjoint literal alternations.
// CJK literals have stable, distinct non-Unicode ignore-case canonical forms.
const alternatives = Array.from({ length: 2_000 }, (_, index) =>
  String.fromCharCode(0x4e00 + index),
).join("|");
const analysisStart = performance.now();
const analysisIssue = analyzeRegexSafety(`(?:${alternatives})+`, { ignoreCase: true });
const analysisDuration = performance.now() - analysisStart;
if (analysisIssue) throw new Error(`Safe large alternation was rejected: ${analysisIssue}`);
if (analysisDuration > 1_000) {
  throw new Error(`Large alternation analysis took ${analysisDuration.toFixed(1)}ms`);
}

// A repeated param whose pattern can also consume its separator (`a+` joined
// by `a`, or `a/a|a` joined by `/`) splits the same text many ways.
for (const [matcher, nearMiss] of [
  ["/{a:x(a+)}*/end", `/${"a".repeat(3_000)}!`],
  ["/:x(a/a|a)*/end", `/${"a/".repeat(1_500)}a!`],
  ["/{:x-}*/end", `/${"a-".repeat(1_500)}a!`],
  ["/:x(a|b|a/b)*/end", `/${"a/b/".repeat(1_000)}!`],
  // An astral separator is two UTF-16 code units, as the RegExp sees it.
  ["/{😀:x(a|😀a|a😀)}*/end", `/${"😀a".repeat(1_000)}!`],
  // Ambiguity inside the pattern is multiplied by every occurrence.
  ["/:x(a|a)*/end", `/${"a/".repeat(1_500)}!`],
  ["/:x([^/]+b[^/]+)*/end", `/${"abba/".repeat(1_000)}!`],
]) {
  if (!matchPattern(nearMiss, matcher)) {
    throw new Error(`Unsafe separated repeat did not fail closed: ${matcher}`);
  }
}

// A lookaround that scans unboundedly is re-run for every repetition.
for (const matcher of [
  "/:x((?:(?=a*b)a)+b)",
  "/:x((?!.*c)[^/]+)*",
  "/:x((?=(?!.*Z)a)a)*/end",
  // A bound far above request-path sizes scans like an unbounded one.
  "/:x((?=.{0,65535}e)a)*/end",
]) {
  if (!matchPattern(`/${"a".repeat(3_000)}!`, matcher)) {
    throw new Error(`Unsafe repeated lookaround did not fail closed: ${matcher}`);
  }
}

// An alternation with an unbounded branch is checked at its boundaries like a
// repetition, so a chain of overlapping ones is still rejected. A branch with
// two variable-width elements, such as `a*a*`, hides a second overlapping
// boundary, so that alternation is not treated as one repetition.
for (const pattern of [
  "(?:a*|b)".repeat(8) + "c",
  ".*(\\d+|x)\\d+",
  "^(?:a*a*|x)(?:a*a*|x)Z$",
  "^(?:a+|x)(?:a+|x)Z$",
  // Fixed text that the variable branch can consume does not end its boundary.
  "^(?:a+|x)a(?:a+|x)a(?:a+|x)Z$",
  // Two boundaries across consumable literals, one of them an alternation.
  "^a+aa+a(?:a+|x)Z$",
]) {
  if (!analyzeRegexSafety(pattern, { ignoreCase: true })) {
    throw new Error(`Unsafe alternation sequence was accepted: ${pattern}`);
  }
}
// A bounded repetition runs a lookaround a fixed number of times.
for (const pattern of [
  "x(?:\\d+|new)y",
  "(?:foo.*|bar)baz",
  "[^/]+(?:\\.(?:[^/.]+))?",
  "^(?:(?=a*)b){2}$",
  // One boundary between a repetition and an alternation, across fixed text.
  "^(.*)/(\\d+|new)$",
  "^(.*)/(\\d+|new)/edit$",
]) {
  const issue = analyzeRegexSafety(pattern, { ignoreCase: true });
  if (issue) throw new Error(`Safe pattern was rejected: ${pattern} (${issue})`);
}

const catchAllWithId = "/:path(.*)/:id(\\d+|new)";
if (!matchPattern(`/${"1/".repeat(2_000)}new`, catchAllWithId)) {
  throw new Error(`Safe catch-all matcher did not match: ${catchAllWithId}`);
}
if (matchPattern(`/${"1/".repeat(2_000)}x!`, catchAllWithId)) {
  throw new Error(`Safe catch-all matcher matched a near miss: ${catchAllWithId}`);
}

// An unprefixed repeat is checked with the `/` prefix Next's normalization
// adds, which is its real separator.
const unprefixedRepeat = "/foo-:x((?![^/]*foo)[^/]+)*";
if (!matchPattern(`/foo-${"/a".repeat(1_500)}`, unprefixedRepeat)) {
  throw new Error(`Normalized repeat did not match: ${unprefixedRepeat}`);
}
if (matchPattern(`/foo-${"/a".repeat(1_500)}foo`, unprefixedRepeat)) {
  throw new Error(`Normalized repeat matched a near miss: ${unprefixedRepeat}`);
}

// A lookaround that cannot match the separator stops at the next one, a
// fixed-width param splits its input one way even if it matches the separator,
// and so do finite alternatives that the separator decodes uniquely.
for (const [matcher, match, nearMiss] of [
  ["/:x((?![^/]*foo)[^/]+)*", `/${"a/".repeat(1_500)}a`, `/${"a/".repeat(1_500)}afoo`],
  ["/{a:x([ab])}*/end", `/${"ab".repeat(1_500)}/end`, `/${"ab".repeat(1_500)}a/end`],
  [
    "/:x(foo/bar|baz)*/end",
    `/${"foo/bar/baz/".repeat(500)}end`,
    `/${"foo/bar/baz/".repeat(500)}foo!`,
  ],
  ["/:x(a|a/b)*/end", `/${"a/b/a/".repeat(500)}end`, `/${"a/b/".repeat(1_000)}b!`],
  ["/:p(\\w+-\\w+)*/end", `/${"a-b/".repeat(1_000)}end`, `/${"a-b/".repeat(1_000)}a-!`],
  ["/:x(ab+|ac+)*/end", `/${"abb/acc/".repeat(500)}end`, `/${"abb/acc/".repeat(500)}a!`],
  [
    "/:x(a+(?:ab|cd)c+)*/end",
    `/${"aabc/acdcc/".repeat(500)}end`,
    `/${"aabc/acdcc/".repeat(500)}aab!`,
  ],
  ["/:x(a+b|a+c)*/end", `/${"aab/ac/".repeat(500)}end`, `/${"aab/ac/".repeat(500)}a!`],
  ["/:x(a*b+|a+c+)*/end", `/${"aab/acc/".repeat(500)}end`, `/${"aab/acc/".repeat(500)}a!`],
  [
    "/:x((?!foo)[^/]+|foo)*/end",
    `/${"foo/bar/".repeat(500)}end`,
    `/${"foo/bar/".repeat(500)}foobar/end`,
  ],
  [
    "/:x(x?a+(?:ab|cd)c+)*/end",
    `/${"xaabc/acdcc/".repeat(500)}end`,
    `/${"xaabc/acdcc/".repeat(500)}xaab!`,
  ],
]) {
  if (!matchPattern(match, matcher)) {
    throw new Error(`Safe separated repeat did not match: ${matcher}`);
  }
  if (matchPattern(nearMiss, matcher)) {
    throw new Error(`Safe separated repeat matched a near miss: ${matcher}`);
  }
}

// The separated-repeat check fails closed when the parser cannot consume the
// whole pattern, e.g. an inline modifier group containing a nested group.
const unparsedIssue = analyzeSeparatedRepetitionSafety("(?i:(?:a))|aa", "/", {
  ignoreCase: true,
});
if (unparsedIssue !== "analysis budget exceeded") {
  throw new Error(`Partially parsed separated repeat was not refused: ${unparsedIssue}`);
}

// Inline modifier groups are not modeled, so their contents cannot be
// checked: fail closed instead of skipping them.
for (const pattern of ["(?i:(?:a+)+b)", "(?i:a*a*a*a*a*a*a*a*b)", "(?i:(?:x))(?:a|aa)+c"]) {
  if (analyzeRegexSafety(pattern, { ignoreCase: true }) !== "analysis budget exceeded") {
    throw new Error(`Inline modifier group was not refused: ${pattern}`);
  }
}
