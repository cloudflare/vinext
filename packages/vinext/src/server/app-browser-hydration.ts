import type { hydrateRoot, ReactFormState } from "react-dom/client";
import {
  BEFORE_INTERACTIVE_QUEUE_GLOBAL,
  RSC_FORM_STATE_GLOBAL,
} from "../client/browser-globals.js";

type HydrateRootOptions = NonNullable<Parameters<typeof hydrateRoot>[2]>;
type HydrateRoot = typeof hydrateRoot;
type HydrateRootContainer = Parameters<HydrateRoot>[0];
type HydrateRootChildren = Parameters<HydrateRoot>[1];
type HydrateRootReturn = ReturnType<HydrateRoot>;
type HydrateRootCaughtErrorHandler = NonNullable<HydrateRootOptions["onCaughtError"]>;
type HydrateRootUncaughtErrorHandler = NonNullable<HydrateRootOptions["onUncaughtError"]>;
type HydrateRootRecoverableErrorHandler = NonNullable<HydrateRootOptions["onRecoverableError"]>;
type StartTransition = (action: () => void) => void;

type FormStateGlobal = {
  [RSC_FORM_STATE_GLOBAL]?: ReactFormState;
};

export function consumeInitialFormState(global: FormStateGlobal): ReactFormState | null {
  const formState = global[RSC_FORM_STATE_GLOBAL] ?? null;
  delete global[RSC_FORM_STATE_GLOBAL];
  return formState;
}

/** A queued beforeInteractive script: attribute pairs, then the body (null for `src`). */
export type BeforeInteractiveQueueEntry = [attributes: [string, string][], content: string | null];

type BeforeInteractiveQueueGlobal = {
  [BEFORE_INTERACTIVE_QUEUE_GLOBAL]?: BeforeInteractiveQueueEntry[];
};

type ScriptDocument = {
  createElement(tagName: "script"): HTMLScriptElement;
  head: Pick<HTMLHeadElement, "appendChild">;
};

/**
 * Inserts the queued beforeInteractive scripts (see
 * server/before-interactive-head.ts) one at a time, in order, like Next.js's
 * `loadScriptsInSequence`: each `src` script once the previous one has loaded
 * or failed, each inline one a task after the previous one. Settles after the
 * last, so hydration starts after them. Returns null when nothing is queued,
 * so hydration does not wait at all.
 */
export function runBeforeInteractiveQueue(
  global: BeforeInteractiveQueueGlobal,
  doc?: ScriptDocument,
): Promise<void> | null {
  const queue = global[BEFORE_INTERACTIVE_QUEUE_GLOBAL];
  if (queue === undefined || queue.length === 0) return null;
  const target: ScriptDocument = doc ?? document;
  let previous = Promise.resolve();
  for (const [attributes, content] of queue) {
    previous = previous.then(
      () =>
        new Promise<void>((resolve) => {
          const script = target.createElement("script");
          // Created scripts start out async; clear it so queued modules keep
          // their order unless the author asked for `async`.
          script.async = false;
          // The first of any case-insensitive duplicate wins, as in the parser.
          for (const [name, value] of attributes) {
            if (!script.hasAttribute(name)) script.setAttribute(name, value);
          }
          if (content === null) {
            script.onload = script.onerror = () => resolve();
          } else {
            script.text = content;
            setTimeout(resolve);
          }
          target.head.appendChild(script);
        }),
    );
  }
  return previous;
}

export function createVinextHydrateRootOptions(options: {
  formState: ReactFormState | null;
  onCaughtError?: HydrateRootCaughtErrorHandler;
  onRecoverableError?: HydrateRootRecoverableErrorHandler;
  onUncaughtError: HydrateRootUncaughtErrorHandler;
}): HydrateRootOptions {
  const hydrateOptions = {
    formState: options.formState,
    ...(options.onRecoverableError ? { onRecoverableError: options.onRecoverableError } : {}),
    onUncaughtError: options.onUncaughtError,
  };

  if (options.onCaughtError) {
    return {
      ...hydrateOptions,
      onCaughtError: options.onCaughtError,
    };
  }

  return hydrateOptions;
}

export function hydrateRootInTransition(options: {
  children: HydrateRootChildren;
  container: HydrateRootContainer;
  hydrateRoot: HydrateRoot;
  options: HydrateRootOptions;
  startTransition: StartTransition;
}): HydrateRootReturn {
  let root: HydrateRootReturn | undefined;

  options.startTransition(() => {
    root = options.hydrateRoot(options.container, options.children, options.options);
  });

  if (root === undefined) {
    throw new Error("[vinext] React.startTransition did not synchronously start hydration");
  }

  return root;
}

/**
 * The pathname and query to hydrate with when the initial Flight payload is
 * fetched instead of embedded, matching what SSR rendered: the query the
 * server rendered (`X-Vinext-Rendered-Path-And-Search`), which a rewrite may
 * have changed, under the public pathname `usePathname()` exposes. The
 * header's path is the rewrite target, so it is never the pathname.
 */
export function resolveFetchedHydrationLocation(
  renderedPathAndSearch: string | null,
  location: Pick<Location, "origin" | "pathname" | "search">,
): { pathname: string; search: string } {
  return {
    pathname: location.pathname,
    search:
      renderedPathAndSearch === null
        ? location.search
        : new URL(renderedPathAndSearch, location.origin).search,
  };
}
