export const CHUNK_RECOVERY_STORAGE_KEY = "__vinext_chunk_recovery__"; // sessionStorage: { "<verdict> <entryUrl>": claimedAt }
export const CHUNK_RECOVERY_WINDOW_MS = 10 * 60_000;
export const CHUNK_RECOVERY_MAX_LOADS = 2; // automatic document loads per tab per window
export const CHUNK_RETRY_DELAY_MIN_MS = 200; // Turbopack parity: one retry after 200-600 ms
export const CHUNK_RETRY_DELAY_SPREAD_MS = 400;
export const BUILD_PROBE_TIMEOUT_MS = 5_000;
export const DOCUMENT_UNLOAD_TIMEOUT_MS = 10_000; // also the App Router's document-navigation expiry

export type ChunkFailureVerdict = "replaced" | "pinned";
export type ChunkRecoveryNavigator = (outcome: {
  onCanceled(): void; // a confirmed abort; the claim is released
  onAbandoned(): void; // no unload within DOCUMENT_UNLOAD_TIMEOUT_MS; the claim stays spent
}) => boolean; // false: refused, nothing started

type Claims = Record<string, number>;
type NavigateEvent = Event & {
  destination: { sameDocument: boolean };
  downloadRequest: string | null;
  signal: AbortSignal;
};
type NavigationApi = {
  addEventListener(
    type: "navigate",
    listener: (event: NavigateEvent) => void,
    options?: { signal?: AbortSignal },
  ): void;
};

type State = {
  entryUrl: string | null;
  immediate: boolean;
  listening: boolean;
  navigator: ChunkRecoveryNavigator | null;
  pending: { at: number; signal: AbortSignal } | null;
  recovery: { errors: Set<object>; promise: Promise<never> } | null;
  // A failed loader that retried and failed again with a new error maps to true
  // (recovers once a live probe shows the browser pinned the failure). Any other
  // recorded failure maps to false (recovers only from a replaced build).
  registry: WeakMap<object, boolean>;
  unloading: boolean;
};

const STATE_KEY = Symbol.for("vinext.chunk-recovery");
const HANDLED_MESSAGE =
  "[vinext] A vite:preloadError listener handled this script failure, so vinext did not recover.";
export const REFUSED_MESSAGE =
  "[vinext] A script failed to load. Reload the page by hand; if that fails, check the deploy for missing built assets.";
const WARNINGS: Record<ChunkFailureVerdict, string> = {
  pinned: "[vinext] A script failed to load and will not be retried. Reloading the page.",
  replaced: "[vinext] This page's build was replaced. Reloading the page.",
};

function getState(): State {
  const host = globalThis as typeof globalThis & { [STATE_KEY]?: State };
  return (host[STATE_KEY] ??= {
    entryUrl: null,
    immediate: true,
    listening: false,
    navigator: null,
    pending: null,
    recovery: null,
    registry: new WeakMap(),
    unloading: false,
  });
}

function isObject(value: unknown): value is object {
  return Object(value) === value;
}

function remember(state: State, error: unknown, retried: boolean): void {
  if (isObject(error)) state.registry.set(error, retried);
}

function forget(state: State, error: unknown): void {
  if (isObject(error)) state.registry.delete(error);
}

// A discarded document never settles; a bfcache-restored one resumes at pageshow.
function resumeWhenShown(state: State): Promise<void> {
  if (!state.unloading) return Promise.resolve();
  return new Promise((resolve) =>
    window.addEventListener("pageshow", () => resolve(), { once: true }),
  );
}

function getNavigation(): NavigationApi | undefined {
  return (window as typeof window & { navigation?: NavigationApi }).navigation;
}

export function registerChunkRecovery(options: { entryUrl: string | null }): void {
  const state = getState();
  state.entryUrl = options.entryUrl;
  if (options.entryUrl === null || state.listening) return;
  state.listening = true;

  window.addEventListener("pagehide", () => {
    state.unloading = true;
  });
  window.addEventListener("pageshow", () => {
    state.unloading = false;
    state.pending = null;
  });
  getNavigation()?.addEventListener("navigate", (event) => {
    if (event.destination.sameDocument || event.downloadRequest !== null) return;
    state.pending = { at: Date.now(), signal: event.signal };
  });
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (isObject(payload) && !state.registry.has(payload)) state.registry.set(payload, false);
  });
}

export function setChunkRecoveryNavigator(navigator: ChunkRecoveryNavigator): void {
  getState().navigator = navigator;
}

export function endImmediateClientReferenceRecovery(): void {
  getState().immediate = false;
}

export async function loadChunk<T>(
  load: () => Promise<T>,
  options: { retry?: boolean } = {},
): Promise<T> {
  let failure: unknown;
  let failed = false;

  try {
    const result = await load();
    // Only vinext's own import() loaders treat undefined as a handled preload error.
    if (result !== undefined || options.retry === false) return result;
  } catch (error) {
    failure = error;
    failed = true;
  }

  if (!failed) throw new Error(HANDLED_MESSAGE);

  const state = getState();
  await new Promise((resolve) =>
    setTimeout(resolve, CHUNK_RETRY_DELAY_MIN_MS + Math.random() * CHUNK_RETRY_DELAY_SPREAD_MS),
  );
  await resumeWhenShown(state);

  if (state.recovery) {
    await state.recovery.promise.catch(() => {});
    await resumeWhenShown(state);
    forget(state, failure);
    throw failure;
  }

  if (options.retry === false) {
    remember(state, failure, false);
    throw failure;
  }

  try {
    return await load();
  } catch (error) {
    await resumeWhenShown(state);
    if (error === failure) forget(state, error);
    else remember(state, error, true);
    throw error;
  }
}

export function loadClientReference<T>(load: () => Promise<T>): Promise<T> {
  return loadChunk(load).catch((error: unknown) => {
    if (!getState().immediate) throw error;
    return recoverFromChunkFailure(error);
  });
}

export function recoverFromChunkFailure(error: unknown): Promise<never> {
  const state = getState();
  if (!isObject(error) || !state.registry.has(error)) return Promise.reject(error);

  const active = state.recovery;
  if (active) {
    active.errors.add(error);
    return active.promise.catch(() => {
      throw error;
    });
  }

  const errors = new Set<object>([error]);
  const promise: Promise<never> = decide(state, error, errors).finally(() => {
    if (state.recovery?.promise === promise) state.recovery = null;
  });
  state.recovery = { errors, promise };
  return promise;
}

async function decide(state: State, error: object, errors: Set<object>): Promise<never> {
  if (globalThis.navigator?.onLine === false) throw error;

  const status = await probeBuild(state.entryUrl);
  await resumeWhenShown(state);

  const verdict: ChunkFailureVerdict | null =
    status === "live"
      ? [...errors].some((joined) => state.registry.get(joined))
        ? "pinned"
        : null
      : status;
  if (verdict === null) throw error;

  await settlePendingNavigation(state);
  await resumeWhenShown(state);

  const claimKey = `${verdict} ${state.entryUrl}`;
  if (!claim(claimKey)) {
    console.error(REFUSED_MESSAGE);
    throw error;
  }

  return new Promise<never>((_, reject) => {
    let done = false;
    const listening = new AbortController();
    const finish = (keepClaim: boolean, deregister = true) => {
      if (done) return;
      done = true;
      listening.abort();
      if (!keepClaim) release(claimKey);
      if (deregister) for (const joined of errors) state.registry.delete(joined);
      reject(error);
    };
    window.addEventListener(
      "pageshow",
      (event) => {
        if (event.persisted) finish(true);
      },
      { signal: listening.signal },
    );

    const started = (state.navigator ?? defaultNavigator)({
      onAbandoned: () => finish(true),
      onCanceled: () => finish(false),
    });
    if (started) console.warn(WARNINGS[verdict]);
    else finish(false, false);
  });
}

async function probeBuild(entryUrl: string | null): Promise<"replaced" | "live" | null> {
  if (entryUrl === null) return null;

  try {
    const { headers, status, type } = await fetch(entryUrl, {
      cache: "no-store",
      credentials: "same-origin",
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(BUILD_PROBE_TIMEOUT_MS),
    });
    if (type === "opaqueredirect" || [401, 403, 404, 410].includes(status)) return "replaced";
    if (status < 200 || status > 299) return null;

    const contentType = headers.get("content-type");
    return contentType !== null && !/(?:java|ecma)script/i.test(contentType) ? "replaced" : "live";
  } catch {
    return null;
  }
}

function waitForNavigation(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const listening = new AbortController();
    const resume = () => {
      clearTimeout(timer);
      listening.abort();
      resolve();
    };
    const timer = setTimeout(resume, ms);
    signal?.addEventListener("abort", resume, { signal: listening.signal });
    window.addEventListener("pageshow", resume, { signal: listening.signal });
  });
}

async function settlePendingNavigation(state: State): Promise<void> {
  const pending = state.pending;
  if (pending === null || pending.signal.aborted) return;
  const remaining = DOCUMENT_UNLOAD_TIMEOUT_MS - (Date.now() - pending.at);
  if (remaining > 0) await waitForNavigation(pending.signal, remaining);
}

function readClaims(storage: Storage, now: number): Claims {
  try {
    const stored: unknown = JSON.parse(storage.getItem(CHUNK_RECOVERY_STORAGE_KEY) ?? "{}");
    const claims: Claims = {};
    for (const [key, at] of Object.entries(stored ?? {})) {
      if (typeof at === "number" && now - at < CHUNK_RECOVERY_WINDOW_MS) claims[key] = at;
    }
    return claims;
  } catch {
    return {};
  }
}

function writeClaims(storage: Storage, claims: Claims): boolean {
  const written = JSON.stringify(claims);
  storage.setItem(CHUNK_RECOVERY_STORAGE_KEY, written);
  return storage.getItem(CHUNK_RECOVERY_STORAGE_KEY) === written;
}

function claim(key: string): boolean {
  try {
    const storage = window.sessionStorage;
    const now = Date.now();
    const claims = readClaims(storage, now);
    if (key in claims || Object.keys(claims).length >= CHUNK_RECOVERY_MAX_LOADS) return false;

    claims[key] = now;
    return writeClaims(storage, claims);
  } catch {
    return false;
  }
}

function release(key: string): void {
  try {
    const storage = window.sessionStorage;
    const claims = readClaims(storage, Date.now());
    delete claims[key];
    writeClaims(storage, claims);
  } catch {
    // Storage that refuses the release leaves the claim spent, which is the safe side.
  }
}

const defaultNavigator: ChunkRecoveryNavigator = (outcome) => {
  const state = getState();
  const before = state.pending;
  window.location.replace(toDocumentLoadHref(window.location.href));
  const signal = state.pending === before ? undefined : state.pending?.signal;

  const settle = () => {
    if (state.unloading) return;
    if (signal?.aborted) outcome.onCanceled();
    else outcome.onAbandoned();
  };
  if (signal?.aborted) settle();
  else void waitForNavigation(signal, DOCUMENT_UNLOAD_TIMEOUT_MS).then(settle);
  return true;
};

export function toDocumentLoadHref(target: string): string {
  const current = window.location.href.split("#", 1)[0];
  return new URL(target, window.location.href).href.split("#", 1)[0] === current ? current : target;
}
