import { randomUUID } from "node:crypto";

export type DevMiddlewareContext = {
  headers: [string, string][];
  rewriteUrl: string | null;
  status: number | null;
};

type StoredDevMiddlewareContext = {
  context: DevMiddlewareContext;
  expiresAt: number;
};

const REGISTRY_SYMBOL = Symbol.for("vinext.devMiddlewareContextRegistry");
const CONTEXT_TTL_MS = 30_000;
const MAX_CONTEXTS = 1_000;

type RegistryProcess = typeof process & {
  [REGISTRY_SYMBOL]?: Map<string, StoredDevMiddlewareContext>;
};

function getRegistry(): Map<string, StoredDevMiddlewareContext> {
  const registryProcess = process as RegistryProcess;
  return (registryProcess[REGISTRY_SYMBOL] ??= new Map());
}

function pruneRegistry(registry: Map<string, StoredDevMiddlewareContext>, now: number): void {
  for (const [handle, stored] of registry) {
    if (stored.expiresAt <= now || registry.size >= MAX_CONTEXTS) {
      registry.delete(handle);
    }
    if (registry.size < MAX_CONTEXTS) break;
  }
}

export function storeDevMiddlewareContext(context: DevMiddlewareContext): string {
  const registry = getRegistry();
  const now = Date.now();
  pruneRegistry(registry, now);

  const handle = randomUUID();
  registry.set(handle, { context, expiresAt: now + CONTEXT_TTL_MS });
  return handle;
}

export function consumeDevMiddlewareContext(handle: string): DevMiddlewareContext | null {
  const registry = getRegistry();
  const stored = registry.get(handle);
  registry.delete(handle);

  if (!stored || stored.expiresAt <= Date.now()) return null;
  return stored.context;
}
