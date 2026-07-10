import { matchPattern } from "../../packages/vinext/src/server/middleware-matcher.ts";

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
