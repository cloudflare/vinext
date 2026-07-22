/**
 * Type declarations for scripts/classify-nextjs-suites.mjs.
 *
 * The script is plain JS so it can be invoked directly via `node scripts/...`
 * from CI without a build step, but it's also imported from
 * `tests/classify-nextjs-suites.test.ts`. These declarations satisfy
 * tsc / oxlint without requiring a checkJs / allowJs config flip.
 */

export type RouterKind = "app" | "pages" | "both" | "unknown";

/**
 * Classify a single Next.js test suite by inspecting its on-disk fixture.
 *
 * @param nextjsDir absolute path to a Next.js checkout root
 * @param suite     relative test file path, e.g. "test/e2e/foo/foo.test.ts"
 * @param overrides optional hand-curated suite → router map (consulted first)
 */
export function classifySuite(
  nextjsDir: string,
  suite: string,
  overrides?: Record<string, RouterKind>,
): RouterKind;

/**
 * Load the overrides file at scripts/nextjs-suite-overrides.json, if present.
 * Returns an empty object when the file is missing or malformed.
 */
export function loadOverrides(): Promise<Record<string, RouterKind>>;

/**
 * Classify many suites in one pass. Reads the overrides file once.
 */
export function classifySuites(
  nextjsDir: string,
  suites: readonly string[],
): Promise<Map<string, RouterKind>>;
