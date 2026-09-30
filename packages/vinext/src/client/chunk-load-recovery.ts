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

type ClaimRecord = { entryUrl: string | null; verdict: ChunkFailureVerdict; at: number };
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
const REFUSED_MESSAGE =
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
    onPageshow: new Set(),
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
  return new Promise((resolve) => {
    const resume = () => {
      state.onPageshow.delete(resume);
      resolve();
    };
    state.onPageshow.add(resume);
  });
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
  window.addEventListener("pageshow", (event) => {
    state.unloading = false;
    state.pending = null;
    for (const notify of state.onPageshow) notify((event as PageTransitionEvent).persisted);
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
    if (result !== undefined) return result;
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

  const record = claim(state.entryUrl, verdict);
  if (record === null) {
    console.error(REFUSED_MESSAGE);
    throw error;
  }

  return new Promise<never>((_, reject) => {
    let done = false;
    const finish = (keepClaim: boolean, deregister = true) => {
      if (done) return;
      done = true;
      state.onPageshow.delete(onShown);
      if (!keepClaim) release(record);
      if (deregister) for (const joined of errors) state.registry.delete(joined);
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
    if (started) {
      console.warn(WARNINGS[verdict]);
    } else {
      console.error(REFUSED_MESSAGE);
      finish(false, false);
    }
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
  try {
    const records: ClaimRecord[] = JSON.parse(storage.getItem(CHUNK_RECOVERY_STORAGE_KEY) ?? "[]");
    return records.filter(
      (record) => typeof record?.at === "number" && now - record.at < CHUNK_RECOVERY_WINDOW_MS,
    );
  } catch {
    return [];
  }
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
  const { signal } = listening;
  const stop = () => {
    clearTimeout(timer);
    listening.abort();
  };
  const timer = setTimeout(() => {
    stop();
    outcome.onAbandoned();
  }, DOCUMENT_UNLOAD_TIMEOUT_MS);
  let captured = false;

  getNavigation()?.addEventListener(
    "navigate",
    (event) => {
      if (captured || event.destination.sameDocument) return;
      captured = true;
      event.signal.addEventListener(
        "abort",
        () => {
          stop();
          outcome.onCanceled();
        },
        { signal },
      );
    },
    { signal },
  );
  window.addEventListener("pagehide", stop, { signal });

  location.replace(toDocumentLoadHref(location.href));
  if (!captured) listening.abort();
  return true;
};

export function toDocumentLoadHref(target: string): string {
  const current = window.location.href.split("#", 1)[0];
  return new URL(target, window.location.href).href.split("#", 1)[0] === current ? current : target;
}
