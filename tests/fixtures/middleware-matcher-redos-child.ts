import { matchPattern } from "../../packages/vinext/src/server/middleware-matcher.ts";

const nearMiss = `/${"a/".repeat(2_000)}not-end`;
for (const modifier of ["*", "+"]) {
  // lgtm[js/redos] — deliberately hostile matcher executed in a timed child.
  const matcher = `/:path(.*)${modifier}/end`;
  if (!matchPattern(nearMiss, matcher)) {
    throw new Error(`Unsafe matcher did not fail closed: ${matcher}`);
  }
}
