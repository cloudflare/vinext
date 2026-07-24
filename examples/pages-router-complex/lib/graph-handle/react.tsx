import { createContext, useContext, useEffect, useMemo, useState } from "react";

import type { PublicSettings } from "../runtime-settings/settings";
import { ViewKind } from "../view/kind";
import type { PrefetchedGraphState, PrefetchStore } from "./prefetch-state";
import { opCacheKey, prefetchStore } from "./prefetch-state";

export type BrowserGraphHandle = {
  memory: PrefetchStore;
  url: string;
  retryLadder: { attempts: number; label: string };
};

const GraphHandleContext = createContext<BrowserGraphHandle | null>(null);

export const GraphHandleProvider = ({
  value,
  children,
}: {
  value: BrowserGraphHandle;
  children: React.ReactNode;
}) => (
  <GraphHandleContext.Provider value={value}>
    {children}
  </GraphHandleContext.Provider>
);

export type BrowserGraphHandleProps = {
  graphSnapshot?: PrefetchedGraphState;
  settings: PublicSettings;
  handleName: string;
};

/** Retry ladders by view kind; listing surfaces retry hardest. */
const RETRY_LADDERS: Record<string, { attempts: number; label: string }> = {
  [ViewKind.GALLERY]: { attempts: 3, label: "wall-retry" },
  [ViewKind.LOOKUP]: { attempts: 3, label: "wall-retry" },
  [ViewKind.DETAIL]: { attempts: 2, label: "focus-retry" },
};

const DEFAULT_RETRY_LADDER = { attempts: 1, label: "tunable-retry" };

/**
 * The retry ladder is selected from the handle-name suffix, and the handle
 * instance is created exactly once with the server snapshot seeded as its
 * initial memory so hydration never refetches.
 */
export const useBrowserGraphHandle = ({
  settings,
  graphSnapshot,
  handleName,
}: BrowserGraphHandleProps): BrowserGraphHandle => {
  const retryLadder = useMemo(() => {
    const suffix = handleName.split("-").at(-1) ?? "";
    return RETRY_LADDERS[suffix] ?? DEFAULT_RETRY_LADDER;
  }, [handleName]);

  const [handle] = useState<BrowserGraphHandle>(() => ({
    memory: prefetchStore({ browser: true, seedState: graphSnapshot }),
    url: settings.dataEdge.url,
    retryLadder,
  }));

  return handle;
};

export type GraphOpResult<T> = {
  data: T | undefined;
  inFlight: boolean;
  fromSnapshot: boolean;
};

/**
 * Memory-first op hook. Server-prefetched results resolve synchronously from
 * the seeded snapshot; anything else round-trips to the data-edge endpoint.
 */
export const useGraphOp = <T,>(
  op: string,
  variables: Record<string, unknown> = {},
): GraphOpResult<T> => {
  const handle = useContext(GraphHandleContext);
  if (!handle) {
    throw new Error("useGraphOp must be used inside GraphHandleProvider");
  }

  const key = opCacheKey(op, variables);
  const held = handle.memory.read(key);

  const [result, setResult] = useState<GraphOpResult<T>>(() =>
    held
      ? { data: held.data as T, inFlight: false, fromSnapshot: true }
      : { data: undefined, inFlight: true, fromSnapshot: false },
  );

  useEffect(() => {
    if (handle.memory.read(key)) {
      return;
    }
    let cancelled = false;
    fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, variables }),
    })
      .then((response) => response.json())
      .then((payload: { data: unknown }) => {
        if (cancelled) return;
        handle.memory.write(key, payload.data);
        setResult({ data: payload.data as T, inFlight: false, fromSnapshot: false });
      })
      .catch(() => {
        if (cancelled) return;
        setResult({ data: undefined, inFlight: false, fromSnapshot: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return result;
};
