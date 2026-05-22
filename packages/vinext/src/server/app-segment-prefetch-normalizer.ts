/**
 * Segment-prefetch RSC URL normalizer.
 *
 * Matches and extracts segment-prefetch URLs following the Next.js convention:
 *   /page-path.segments/_tree.segment.rsc
 *   /page-path.segments/_index.segment.rsc
 *   /page-path.segments/dashboard/__PAGE__.segment.rsc
 *
 * The normalizer extracts the original page pathname and the segment path,
 * allowing the request to be routed through the normal RSC pipeline with
 * the segment metadata set as request markers.
 *
 * Constants match Next.js: RSC_SEGMENTS_DIR_SUFFIX = '.segments',
 * RSC_SEGMENT_SUFFIX = '.segment.rsc'
 */

const RSC_SEGMENTS_DIR_SUFFIX = ".segments";
const RSC_SEGMENT_SUFFIX = ".segment.rsc";

const SEGMENT_PREFETCH_PATTERN = new RegExp(
  `^(/.*)${escapeRegex(RSC_SEGMENTS_DIR_SUFFIX)}(/.*)${escapeRegex(RSC_SEGMENT_SUFFIX)}$`,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type SegmentPrefetchResult = {
  /** The original page pathname without segment-prefetch suffixes (e.g. "/dashboard"). */
  originalPathname: string;
  /** The segment path (e.g. "/_tree", "/_index", "/dashboard/__PAGE__"). */
  segmentPath: string;
};

/**
 * Check if a pathname matches the segment-prefetch URL pattern and extract the
 * original page pathname and segment path.
 *
 * Returns null when the pathname does not match the expected pattern.
 * This is the single entry point — prefer it over a separate match + extract
 * to avoid running the regex twice on the hot path.
 */
export function extractSegmentPrefetchRsc(pathname: string): SegmentPrefetchResult | null {
  const match = pathname.match(SEGMENT_PREFETCH_PATTERN);
  if (!match) return null;
  return { originalPathname: match[1], segmentPath: match[2] };
}

/**
 * Check if a pathname matches the segment-prefetch URL pattern.
 *
 * Prefer extractSegmentPrefetchRsc() when you need the extracted path info,
 * since it runs the regex once and returns null for non-matches.
 */
export function matchSegmentPrefetchRsc(pathname: string): boolean {
  return SEGMENT_PREFETCH_PATTERN.test(pathname);
}
