export type AppBrowserDocumentLoad = {
  readonly status: "pending" | "started" | "superseded";
};

type TrackedDocumentLoad = AppBrowserDocumentLoad & {
  onStart: (() => void)[];
  onSupersede: (() => void)[];
  status: AppBrowserDocumentLoad["status"];
};

/**
 * Tracks the document loads the App Router starts. A mounted router loads a
 * document through its MPA state, which only loads once React renders it: a
 * router update that lands first replaces the state, and nothing loads. Work
 * that only makes sense once the page is unloading (dropping a queued
 * refresh, ending a back/forward scroll restore) waits for the load to start.
 * Work for a superseded load waits for the replacement to commit, so it sees
 * the router state (and URL) that replaced the MPA state.
 */
export function createAppBrowserDocumentLoadTracker(): {
  /**
   * The router committed a render, or returned to its committed tree; runs
   * the callbacks of superseded loads.
   */
  commit(): void;
  /** The MPA state was entered; one entered before it renders joins it. */
  enter(): AppBrowserDocumentLoad;
  /** How many times the MPA state was entered, including joins. */
  entries(): number;
  /** The latest load entered, if any. */
  latest(): AppBrowserDocumentLoad | null;
  /**
   * Runs `onStart` once `load` starts, or `onSupersede` once the update that
   * replaced it commits.
   */
  onSettled(load: AppBrowserDocumentLoad, onStart: () => void, onSupersede?: () => void): void;
  /** `load` started: the MPA state rendered, or the router loaded directly. */
  start(load: AppBrowserDocumentLoad): void;
  /** A router update replaced the MPA state before it rendered. */
  supersede(): void;
} {
  const loads = new WeakMap<AppBrowserDocumentLoad, TrackedDocumentLoad>();
  // Superseded loads whose replacement has not committed yet.
  const awaitingCommit = new Set<TrackedDocumentLoad>();
  let pendingLoad: TrackedDocumentLoad | null = null;
  let latestLoad: TrackedDocumentLoad | null = null;
  let entryCount = 0;

  function run(callbacks: (() => void)[]): void {
    for (const callback of callbacks) callback();
  }

  return {
    commit() {
      const superseded = [...awaitingCommit];
      awaitingCommit.clear();
      for (const load of superseded) {
        const callbacks = load.onSupersede;
        load.onSupersede = [];
        run(callbacks);
      }
    },
    enter() {
      entryCount += 1;
      if (pendingLoad !== null) return pendingLoad;
      const load: TrackedDocumentLoad = { onStart: [], onSupersede: [], status: "pending" };
      loads.set(load, load);
      pendingLoad = load;
      latestLoad = load;
      return load;
    },
    entries() {
      return entryCount;
    },
    latest() {
      return latestLoad;
    },
    onSettled(load, onStart, onSupersede) {
      const tracked = loads.get(load);
      if (tracked === undefined) return;
      if (tracked.status === "started") {
        onStart();
      } else if (tracked.status === "superseded") {
        if (!onSupersede) return;
        if (awaitingCommit.has(tracked)) tracked.onSupersede.push(onSupersede);
        else onSupersede();
      } else {
        tracked.onStart.push(onStart);
        if (onSupersede) tracked.onSupersede.push(onSupersede);
      }
    },
    start(load) {
      const tracked = loads.get(load);
      if (tracked === undefined || tracked.status !== "pending") return;
      tracked.status = "started";
      if (pendingLoad === tracked) pendingLoad = null;
      const callbacks = tracked.onStart;
      tracked.onStart = [];
      tracked.onSupersede = [];
      run(callbacks);
    },
    supersede() {
      if (pendingLoad === null) return;
      pendingLoad.status = "superseded";
      pendingLoad.onStart = [];
      awaitingCommit.add(pendingLoad);
      pendingLoad = null;
    },
  };
}
