const NEXT_REDIRECT_PREFIX = "NEXT_REDIRECT;";

export type RedirectDigest = {
  status: number;
  type: string | null;
  url: string;
};

export function parseRedirectDigest(digest: string): RedirectDigest | null {
  if (!digest.startsWith(NEXT_REDIRECT_PREFIX)) return null;

  const firstSemi = digest.indexOf(";", NEXT_REDIRECT_PREFIX.length);
  if (firstSemi === -1) return null;

  const rest = digest.slice(firstSemi + 1);
  // Only canonical redirect statuses (303, 307, 308) are recognized;
  // anything else is treated as URL content.
  const statusMatch = rest.match(/;(303|307|308);?$/);
  // Next.js emits raw, semicolon-terminated digests. Vinext's encoded form
  // cannot end in a URL semicolon because encodeURIComponent escapes it, so
  // canonical targets must be preserved verbatim rather than URL-decoded.
  const isCanonical = rest !== "" && digest.endsWith(";");
  if (isCanonical && !statusMatch) return null;

  const target = statusMatch ? rest.slice(0, -statusMatch[0].length) : rest;

  let url = target;
  if (!isCanonical) {
    // Only vinext's encodeURIComponent-produced form reaches this branch;
    // raw redirect digests must use Next.js's status-terminated format.
    try {
      url = decodeURIComponent(target);
    } catch {
      return null;
    }
  }

  return {
    status: statusMatch ? Number(statusMatch[1]) : 307,
    // Vinext permits an empty type so catch sites can choose push for Server
    // Actions and replace elsewhere; other raw values retain prior behavior.
    type: digest.slice(NEXT_REDIRECT_PREFIX.length, firstSemi) || null,
    url,
  };
}
