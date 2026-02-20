/**
 * Minimal type augmentation for Vite's HMR API on ImportMeta.
 *
 * We only declare the subset used by vinext (hot.data) rather than
 * pulling in the full vite/client types, which would add CSS module
 * declarations and other globals inappropriate for a library package.
 */
interface ViteHotData {
  [key: string]: unknown;
}

interface ViteHotContext {
  readonly data: ViteHotData;
  accept(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

interface ImportMeta {
  readonly hot?: ViteHotContext;
}
