/**
 * Route precedence — lower score is higher priority.
 * Matches Next.js specificity rules:
 * 1. Static routes first (scored by segment count, more = more specific)
 * 2. Dynamic segments penalized by position
 * 3. Catch-all comes after dynamic
 * 4. Optional catch-all last
 * 5. Lexicographic tiebreaker for determinism
 *
 * Key insight: routes with a static prefix before a dynamic/catch-all segment
 * should have higher priority than bare dynamic/catch-all routes at the same
 * depth. E.g., /_sites/:subdomain should match before /:subdomain, and
 * /_sites/:subdomain/:slug* should match before /:slug*.
 *
 * The static-prefix boost is capped so it never goes below 1 (i.e. never
 * beats a purely-static route, which scores 0).
 */
export function routePrecedence(pattern: string): number {
  const parts = pattern.split("/").filter(Boolean);
  let score = 0;

  let staticPrefixCount = 0;
  for (const p of parts) {
    if (p.startsWith(":") || p.endsWith("+") || p.endsWith("*")) break;
    staticPrefixCount++;
  }

  const isDynamic = parts.some(
    (p) => p.startsWith(":") || p.endsWith("+") || p.endsWith("*"),
  );

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.endsWith("+")) {
      score += 1000 + i; // catch-all: moderate penalty
    } else if (p.endsWith("*")) {
      score += 2000 + i; // optional catch-all: high penalty
    } else if (p.startsWith(":")) {
      score += 100 + i; // dynamic: small penalty by position
    }
    // static segments after the static prefix (i.e. interleaved with dynamic)
    // boost priority — more specific than a bare catch-all
    else if (i >= staticPrefixCount) {
      score -= 500;
    }
  }

  // Apply a static-prefix boost for routes that have any dynamic segments.
  // This makes /_sites/:subdomain rank above /:subdomain, and
  // /_sites/:slug* rank above /:slug*. The boost is capped at (score - 1)
  // so it can never push the final score below 1 — purely static routes
  // always score 0 and must remain highest priority.
  if (isDynamic && staticPrefixCount > 0) {
    const boost = staticPrefixCount * 10000;
    score -= Math.min(boost, score - 1);
  }

  return score;
}
