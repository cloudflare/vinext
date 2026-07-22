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
