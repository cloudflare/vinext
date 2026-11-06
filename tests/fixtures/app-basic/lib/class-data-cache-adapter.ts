/**
 * A class-based data cache adapter. tests/app-router-dev-server.test.ts
 * configures it with `vinext({ cache: { data: { adapter, options } } })`.
 *
 * It answers the `/unstable-cache-test` page's `unstable_cache` lookup with a
 * value derived from its constructor options, so the page renders that value
 * only when vinext constructed this class and registered the instance.
 */
type AdapterArgs = { env: unknown; options: { label: string } };
type Entry = { lastModified: number; value: unknown };

// unstable_cache keys are a digest of the callback, keyParts and arguments, so
// the probe answers every unstable_cache lookup. The test only renders the
// `/unstable-cache-test` page, which makes the one lookup.
const PROBE_KEY_PREFIX = "unstable_cache:";

export default class ClassDataCacheAdapter {
  readonly #label: string;
  readonly #entries = new Map<string, Entry>();

  constructor({ options }: AdapterArgs) {
    this.#label = options.label;
  }

  async get(key: string): Promise<Entry | null> {
    if (key.startsWith(PROBE_KEY_PREFIX)) {
      return {
        lastModified: Date.now(),
        value: {
          kind: "FETCH",
          data: {
            headers: {},
            body: JSON.stringify({ v: { value: this.#label, fetchedAt: 0 } }),
            url: "",
          },
          revalidate: false,
        },
      };
    }
    return this.#entries.get(key) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.#entries.set(key, { lastModified: Date.now(), value });
  }

  async revalidateTag(): Promise<void> {}
}
