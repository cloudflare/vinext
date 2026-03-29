/**
 * Minimal type augmentation for Vite's HMR API on ImportMeta.
 *
 * We only declare the subset used by vinext (hot.data) rather than
 * pulling in the full vite/client types, which would add CSS module
 * declarations and other globals inappropriate for a library package.
 */
type ViteHotData = {
  [key: string]: unknown;
};

type ViteHotContext = {
  readonly data: ViteHotData;
  accept(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
};

type ImportMeta = {
  readonly hot?: ViteHotContext;
};
