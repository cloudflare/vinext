export const CHUNK_RECOVERY_STORAGE_KEY = "__vinext_chunk_recovery__"; // sessionStorage: [{ entryUrl, verdict, at }]
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

type Policy = "retry" | "deploy";
type BuildStatus = "replaced" | "live" | "unavailable";
type ClaimRecord = { entryUrl: string | null; verdict: ChunkFailureVerdict; at: number };
type Recovery = { errors: Set<object>; promise: Promise<never> };
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
  onPageshow: Set<(persisted: boolean) => void>;
  pending: { at: number; signal: AbortSignal } | null;
  recovery: Recovery | null;
  registry: WeakMap<object, Policy>;
  unloading: boolean;
};

const STATE_KEY = Symbol.for("vinext.chunk-recovery");
const HANDLED_MESSAGE =
  "[vinext] A vite:preloadError listener handled this script failure, so vinext did not recover.";
const REFUSED_MESSAGE =
  "[vinext] A script failed to load and the page could not be reloaded automatically, so it was left as is. Reloading the page by hand should fix it. If the problem persists, check the deploy for missing built assets.";
const WARNINGS: Record<ChunkFailureVerdict, string> = {
  pinned:
    "[vinext] A script failed to load and this browser will not retry it. Reloading the page.",
  replaced: "[vinext] This page's build is no longer on the server. Loading the current version.",
};
const SCRIPT_CONTENT_TYPE = /(?:java|ecma)script/i;
const REPLACED_STATUSES = new Set([401, 403, 404, 410]);

function getState(): State {
  const host = globalThis as typeof globalThis & { [STATE_KEY]?: State };
  return (host[STATE_KEY] ??= {
    entryUrl: null,
    immediate: true,
    listening: false,
    navigator: null,
    onPageshow: new Set(),
    pending: null,
    recovery: null,
    registry: new WeakMap(),
    unloading: false,
  });
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function remember(state: State, error: unknown, policy: Policy): void {
  if (isObject(error)) state.registry.set(error, policy);
}

function forget(state: State, error: unknown): void {
  if (isObject(error)) state.registry.delete(error);
}

// A discarded document never settles; a bfcache-restored one resumes at pageshow.
function resumeWhenShown(state: State): Promise<void> {
  if (!state.unloading) return Promise.resolve();
  return new Promise((resolve) => {
    const resume = () => {
      state.onPageshow.delete(resume);
      resolve();
    };
    state.onPageshow.add(resume);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerChunkRecovery(options: { entryUrl: string | null }): void {
  const state = getState();
  state.entryUrl = options.entryUrl;
  if (options.entryUrl === null || state.listening) return;
  state.listening = true;

  window.addEventListener("pagehide", () => {
    state.unloading = true;
  });
  window.addEventListener("pageshow", (event) => {
    state.unloading = false;
    state.pending = null;
    for (const notify of state.onPageshow) notify((event as PageTransitionEvent).persisted);
  });
  (window as typeof window & { navigation?: NavigationApi }).navigation?.addEventListener(
    "navigate",
    (event) => {
      if (event.destination.sameDocument || event.downloadRequest !== null) return;
      state.pending = { at: Date.now(), signal: event.signal };
    },
  );
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (isObject(payload) && !state.registry.has(payload)) state.registry.set(payload, "deploy");
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
    if (result !== undefined) return result;
  } catch (error) {
    failure = error;
    failed = true;
  }

  if (!failed) throw new Error(HANDLED_MESSAGE);

  const state = getState();
  await sleep(CHUNK_RETRY_DELAY_MIN_MS + Math.random() * CHUNK_RETRY_DELAY_SPREAD_MS);
  await resumeWhenShown(state);

  if (state.recovery) {
    await state.recovery.promise.catch(() => {});
    await resumeWhenShown(state);
    forget(state, failure);
    throw failure;
  }

  if (options.retry === false) {
    remember(state, failure, "deploy");
    throw failure;
  }

  try {
    return await load();
  } catch (error) {
    await resumeWhenShown(state);
    if (error === failure) forget(state, error);
    else remember(state, error, "retry");
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
    status === "replaced"
      ? "replaced"
      : status === "live" && [...errors].some((joined) => state.registry.get(joined) === "retry")
        ? "pinned"
        : null;
  if (verdict === null) throw error;

  await settlePendingNavigation(state);
  await resumeWhenShown(state);

  const record = claim(state.entryUrl, verdict);
  if (record === null) {
    console.error(REFUSED_MESSAGE);
    throw error;
  }

  return new Promise<never>((_, reject) => {
    let done = false;
    const finish = (keepClaim: boolean) => {
      if (done) return;
      done = true;
      state.onPageshow.delete(onShown);
      if (!keepClaim) release(record);
      for (const joined of errors) state.registry.delete(joined);
      reject(error);
    };
    const onShown = (persisted: boolean) => {
      if (persisted) finish(true);
    };
    state.onPageshow.add(onShown);

    const started = (state.navigator ?? defaultNavigator)({
      onAbandoned: () => finish(true),
      onCanceled: () => finish(false),
    });
    if (!started) {
      done = true;
      state.onPageshow.delete(onShown);
      release(record);
      console.error(REFUSED_MESSAGE);
      reject(error);
      return;
    }

    console.warn(WARNINGS[verdict]);
  });
}

async function probeBuild(entryUrl: string | null): Promise<BuildStatus> {
  if (entryUrl === null) return "unavailable";

  try {
    const response = await fetch(entryUrl, {
      cache: "no-store",
      credentials: "same-origin",
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(BUILD_PROBE_TIMEOUT_MS),
    });
    const { status, type } = response;
    if (type === "opaqueredirect" || REPLACED_STATUSES.has(status)) return "replaced";
    if (status < 200 || status > 299) return "unavailable";

    const contentType = response.headers.get("content-type");
    return contentType !== null && !SCRIPT_CONTENT_TYPE.test(contentType) ? "replaced" : "live";
  } catch {
    return "unavailable";
  }
}

async function settlePendingNavigation(state: State): Promise<void> {
  const pending = state.pending;
  if (pending === null || pending.signal.aborted) return;
  const remaining = DOCUMENT_UNLOAD_TIMEOUT_MS - (Date.now() - pending.at);
  if (remaining <= 0) return;

  await new Promise<void>((resolve) => {
    const resume = () => {
      clearTimeout(timer);
      pending.signal.removeEventListener("abort", resume);
      state.onPageshow.delete(resume);
      resolve();
    };
    const timer = setTimeout(resume, remaining);
    pending.signal.addEventListener("abort", resume);
    state.onPageshow.add(resume);
  });
}

function readClaims(storage: Storage, now: number): ClaimRecord[] {
  let records: unknown;
  try {
    records = JSON.parse(storage.getItem(CHUNK_RECOVERY_STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(records)) return [];
  return records.filter(
    (record: ClaimRecord | null) =>
      isObject(record) &&
      typeof record.at === "number" &&
      now - record.at < CHUNK_RECOVERY_WINDOW_MS,
  );
}

function claim(entryUrl: string | null, verdict: ChunkFailureVerdict): ClaimRecord | null {
  try {
    const storage = window.sessionStorage;
    const now = Date.now();
    const records = readClaims(storage, now);
    if (
      records.length >= CHUNK_RECOVERY_MAX_LOADS ||
      records.some((record) => record.entryUrl === entryUrl && record.verdict === verdict)
    ) {
      return null;
    }

    const record = { at: now, entryUrl, verdict };
    const written = JSON.stringify([...records, record]);
    storage.setItem(CHUNK_RECOVERY_STORAGE_KEY, written);
    return storage.getItem(CHUNK_RECOVERY_STORAGE_KEY) === written ? record : null;
  } catch {
    return null;
  }
}

function release(record: ClaimRecord): void {
  try {
    const storage = window.sessionStorage;
    const kept = readClaims(storage, Date.now()).filter((other) => other.at !== record.at);
    storage.setItem(CHUNK_RECOVERY_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Storage that refuses the release leaves the claim spent, which is the safe side.
  }
}

const defaultNavigator: ChunkRecoveryNavigator = (outcome) => {
  const { location } = window;
  const listening = new AbortController();
  const timer = setTimeout(() => {
    listening.abort();
    outcome.onAbandoned();
  }, DOCUMENT_UNLOAD_TIMEOUT_MS);
  const navigation = (window as typeof window & { navigation?: NavigationApi }).navigation;
  let captured = false;

  navigation?.addEventListener(
    "navigate",
    (event) => {
      if (captured || event.destination.sameDocument) return;
      captured = true;
      event.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          listening.abort();
          outcome.onCanceled();
        },
        { signal: listening.signal },
      );
    },
    { signal: listening.signal },
  );
  window.addEventListener(
    "pagehide",
    () => {
      clearTimeout(timer);
      listening.abort();
    },
    { signal: listening.signal },
  );

  location.replace(toDocumentLoadHref(location.href));
  if (!captured) listening.abort();
  return true;
};

export function toDocumentLoadHref(target: string): string {
  const resolved = new URL(target, window.location.href).href;
  const withoutFragment = (href: string) => href.split("#", 1)[0];
  const current = withoutFragment(window.location.href);
  return withoutFragment(resolved) === current ? current : target;
}
