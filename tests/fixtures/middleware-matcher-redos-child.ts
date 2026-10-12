import { performance } from "node:perf_hooks";
import { matchPattern } from "../../packages/vinext/src/server/middleware-matcher.ts";
import { analyzeRegexSafety } from "../../packages/vinext/src/utils/regex-safety.ts";

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
  // Optional branches still count every match path; unbounded ones fail closed.
  `/:path(${"(?:a|aa?)".repeat(26)})`,
  `/:path(${"(?:a?|b)".repeat(26)}c)`,
  `/:path(${"(?:a*|b)".repeat(8)}c)`,
  // A literal `\.` must not share a trie edge with the wildcard `.`.
  "/:path((?:\\.x|.y|ay)+)",
  `/:path(${"(?:\\.x|.y|ay|b?z)".repeat(26)}c)`,
  // `\cA` is one control character; a bare `\c` is a literal backslash and `c`.
  `/:path(${"(?:\\cA?x|\\x01x)".repeat(26)}c)`,
  "/:path((?:\\c|\\\\c)+)",
  // `\k<z>` is a backreference when any token of the matcher names a group.
  "/:a((?<z>a))/:b((?:\\k<z>x|ax)+c)",
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
  "[^?]*\\.(?:html?|jpe?g|woff2?)",
  // Overlapping first symbols are disjoint through their suffixes.
  "(?:\\.x|.y)+",
  // Without named groups, Annex B reads `\k<z>` as the literal text `k<z>`.
  "(?:\\k<z>x|qx)+",
  // An escaped `\(` cannot open a named group.
  "\\(?<(?:\\k<z>x|qx)+",
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

// Out-of-order bounded ranges are invalid; reject them without iterating to
// the declared maximum.
const malformedRangeStart = performance.now();
const malformedRangeIssue = analyzeRegexSafety("(?:(?:a{2,1}){0,4000000000}|b)c");
const malformedRangeDuration = performance.now() - malformedRangeStart;
if (!malformedRangeIssue) throw new Error("Malformed bounded range was accepted");
if (malformedRangeDuration > 1_000) {
  throw new Error(`Malformed bounded range analysis took ${malformedRangeDuration.toFixed(1)}ms`);
}

// Huge exact counts over unambiguous children must not iterate to the count.
const exactCountStart = performance.now();
analyzeRegexSafety("(?:(?:a?b|c)){4000000000}d");
const exactCountDuration = performance.now() - exactCountStart;
if (exactCountDuration > 1_000) {
  throw new Error(`Exact repeat analysis took ${exactCountDuration.toFixed(1)}ms`);
}

// Named backreferences match their capture, not the literal `\k<name>` text.
for (const pattern of ["^(?<z>a)(?:\\k<z>x|ax)+c$", `^(?<z>a)${"(?:\\k<z>x|ab?x)".repeat(26)}c$`]) {
  if (!analyzeRegexSafety(pattern, { ignoreCase: true })) {
    throw new Error(`Unsafe backreference pattern was accepted: ${pattern}`);
  }
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
