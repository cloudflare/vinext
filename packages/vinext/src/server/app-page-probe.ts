import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { makeThenableParams } from "vinext/shims/thenable-params";
import { collectAppPageSearchParams } from "./app-page-head.js";
import {
  probeAppPageComponent,
  probeAppPageLayouts,
  type AppPageSpecialError,
  type LayoutClassificationOptions,
  type LayoutFlags,
} from "./app-page-execution.js";

const DEFAULT_SUBTREE_PROBE_MAX_DEPTH = 32;
const DEFAULT_SUBTREE_PROBE_MAX_NODES = 1000;
const REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref");
const REACT_LAZY_TYPE = Symbol.for("react.lazy");
const REACT_MEMO_TYPE = Symbol.for("react.memo");

type ProbeReactServerSubtreeOptions = Readonly<{
  maxDepth?: number;
  maxNodes?: number;
}>;

type ProbeReactElementProps = Readonly<{
  children?: ReactNode;
}>;

type UnknownFunction = (...args: unknown[]) => unknown;

type ReactMemoType = Readonly<{
  innerType: unknown;
}>;

type ReactLazyType = Readonly<{
  init: UnknownFunction;
  payload: unknown;
}>;

class AppPageSubtreeProbeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppPageSubtreeProbeLimitError";
  }
}

class AppPageSubtreeProbeUnsupportedIterableError extends Error {
  constructor() {
    super("App page layout subtree probe cannot safely inspect iterable children");
    this.name = "AppPageSubtreeProbeUnsupportedIterableError";
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(
    value &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function",
  );
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return Boolean(
    value &&
    typeof value !== "string" &&
    typeof value === "object" &&
    Symbol.iterator in value &&
    typeof value[Symbol.iterator] === "function",
  );
}

function isProbeReactElement(value: unknown): value is ReactElement<ProbeReactElementProps> {
  return isValidElement<ProbeReactElementProps>(value);
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function isUnknownFunction(value: unknown): value is UnknownFunction {
  return typeof value === "function";
}

function readReactMemoType(value: unknown): ReactMemoType | null {
  if (!isObjectLike(value) || Reflect.get(value, "$$typeof") !== REACT_MEMO_TYPE) {
    return null;
  }
  return { innerType: Reflect.get(value, "type") };
}

function readReactLazyType(value: unknown): ReactLazyType | null {
  if (!isObjectLike(value) || Reflect.get(value, "$$typeof") !== REACT_LAZY_TYPE) {
    return null;
  }
  const init = Reflect.get(value, "_init");
  if (!isUnknownFunction(init)) {
    return null;
  }
  return { init, payload: Reflect.get(value, "_payload") };
}

function readReactForwardRefRender(value: unknown): UnknownFunction | null {
  if (!isObjectLike(value) || Reflect.get(value, "$$typeof") !== REACT_FORWARD_REF_TYPE) {
    return null;
  }
  const render = Reflect.get(value, "render");
  return isUnknownFunction(render) ? render : null;
}

async function resolveReactLazyType(lazyType: ReactLazyType): Promise<unknown> {
  try {
    return lazyType.init(lazyType.payload);
  } catch (error) {
    if (!isPromiseLike(error)) {
      throw error;
    }
    await error;
    return lazyType.init(lazyType.payload);
  }
}

/**
 * Invokes server-component children returned by a layout probe so per-layout
 * skip eligibility observes data dependencies created below the layout's
 * immediate function body. The real RSC render remains authoritative; probe
 * failures only make static-layout skip fall back to render-and-send.
 */
export async function probeReactServerSubtree(
  node: unknown,
  options: ProbeReactServerSubtreeOptions = {},
): Promise<void> {
  const maxDepth = options.maxDepth ?? DEFAULT_SUBTREE_PROBE_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_SUBTREE_PROBE_MAX_NODES;
  let visitedNodes = 0;

  const enterProbeNode = (depth: number): void => {
    if (depth > maxDepth) {
      throw new AppPageSubtreeProbeLimitError("App page layout subtree probe exceeded max depth");
    }
    visitedNodes += 1;
    if (visitedNodes > maxNodes) {
      throw new AppPageSubtreeProbeLimitError("App page layout subtree probe exceeded max nodes");
    }
  };

  const renderElementType = async (
    type: unknown,
    props: ProbeReactElementProps,
    depth: number,
    wrapperDepth = 0,
  ): Promise<boolean> => {
    if (wrapperDepth > maxDepth) {
      throw new AppPageSubtreeProbeLimitError("App page layout subtree probe exceeded max depth");
    }

    if (isUnknownFunction(type)) {
      await visit(type(props), depth + 1);
      return true;
    }

    const memoType = readReactMemoType(type);
    if (memoType) {
      return renderElementType(memoType.innerType, props, depth, wrapperDepth + 1);
    }

    const lazyType = readReactLazyType(type);
    if (lazyType) {
      return renderElementType(
        await resolveReactLazyType(lazyType),
        props,
        depth,
        wrapperDepth + 1,
      );
    }

    const forwardRefRender = readReactForwardRefRender(type);
    if (forwardRefRender) {
      await visit(forwardRefRender(props, null), depth + 1);
      return true;
    }

    return false;
  };

  const visit = async (value: unknown, depth: number): Promise<void> => {
    enterProbeNode(depth);
    if (value == null || typeof value === "boolean" || typeof value === "number") return;
    if (typeof value === "string" || typeof value === "bigint") return;
    if (isPromiseLike(value)) {
      await visit(await value, depth);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        await visit(child, depth + 1);
      }
      return;
    }
    if (isIterable(value) && !isProbeReactElement(value)) {
      throw new AppPageSubtreeProbeUnsupportedIterableError();
    }
    if (!isProbeReactElement(value)) return;

    if (value.type === Fragment || typeof value.type === "string") {
      await visit(value.props.children, depth + 1);
      return;
    }

    if (await renderElementType(value.type, value.props, depth)) {
      return;
    }

    await visit(value.props.children, depth + 1);
  };

  await visit(node, 0);
}

/**
 * Build a probePage() invocation for the App Router request lifecycle.
 *
 * The generated RSC entry calls this once per request after route matching to
 * eagerly invoke the page component. Surfacing redirect()/notFound() throws
 * here lets the probe lifecycle turn them into proper HTTP responses before
 * RSC streaming begins (see `probeAppPageBeforeRender`).
 *
 * The helper exists to keep the generated entry thin (a single delegation
 * call) and to make the search-params wiring directly unit-testable. A bug
 * here previously slipped through because the entry hand-rolled the call and
 * read a non-existent key off `collectAppPageSearchParams`'s return value
 * (see https://github.com/cloudflare/vinext/issues/1235).
 *
 * Returns `null` when the route has no page component (eg. interception-only
 * routes), matching the caller contract on `probePage`.
 */
export function probeAppPage(options: {
  pageComponent: unknown;
  asyncRouteParams: unknown;
  searchParams: URLSearchParams | null | undefined;
}): unknown {
  const { pageComponent, asyncRouteParams, searchParams } = options;
  if (typeof pageComponent !== "function") {
    return null;
  }
  const { pageSearchParams } = collectAppPageSearchParams(searchParams);
  const asyncSearchParams = makeThenableParams(pageSearchParams);
  return (pageComponent as (props: Record<string, unknown>) => unknown)({
    params: asyncRouteParams,
    searchParams: asyncSearchParams,
  });
}

type ProbeAppPageBeforeRenderResult = {
  response: Response | null;
  layoutFlags: LayoutFlags;
};

type ProbeAppPageBeforeRenderOptions = {
  hasLoadingBoundary: boolean;
  layoutCount: number;
  probeLayoutAt: (layoutIndex: number) => unknown;
  probePage: () => unknown;
  renderLayoutSpecialError: (
    specialError: AppPageSpecialError,
    layoutIndex: number,
  ) => Promise<Response>;
  renderPageSpecialError: (specialError: AppPageSpecialError) => Promise<Response>;
  resolveSpecialError: (error: unknown) => AppPageSpecialError | null;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
  /** When provided, enables per-layout static/dynamic classification. */
  classification?: LayoutClassificationOptions | null;
};

export async function probeAppPageBeforeRender(
  options: ProbeAppPageBeforeRenderOptions,
): Promise<ProbeAppPageBeforeRenderResult> {
  let layoutFlags: LayoutFlags = {};

  // Layouts render before their children in Next.js, so layout-level special
  // errors must be handled before probing the page component itself.
  if (options.layoutCount > 0) {
    const layoutProbeResult = await probeAppPageLayouts({
      layoutCount: options.layoutCount,
      async onLayoutError(layoutError, layoutIndex) {
        const specialError = options.resolveSpecialError(layoutError);
        if (!specialError) {
          return null;
        }

        return options.renderLayoutSpecialError(specialError, layoutIndex);
      },
      probeLayoutAt: options.probeLayoutAt,
      runWithSuppressedHookWarning(probe) {
        return options.runWithSuppressedHookWarning(probe);
      },
      classification: options.classification,
    });

    layoutFlags = layoutProbeResult.layoutFlags;

    if (layoutProbeResult.response) {
      return { response: layoutProbeResult.response, layoutFlags };
    }
  }

  // When a route-level loading.tsx is present, the page renders inside a
  // route-level Suspense boundary, so a thrown redirect()/notFound() during
  // page render becomes an error inside that boundary. We can't catch it
  // here without serializing on the page promise — which would defeat the
  // streaming benefit of loading.tsx for slow non-redirecting pages.
  //
  // Recovery for the redirect/notFound case happens later in
  // renderAppPageLifecycle: rscErrorTracker captures the digest from React's
  // onError callback, and a short race window after shell-ready lets the
  // lifecycle swap the response to a 307/404 before bytes are flushed.
  // This mirrors Next.js's "until-first-byte-is-flushed" swap behavior.
  if (options.hasLoadingBoundary) {
    return { response: null, layoutFlags };
  }

  // Server Components are functions, so we can probe the page ahead of stream
  // creation and only turn special throws into immediate responses.
  const pageResponse = await probeAppPageComponent({
    awaitAsyncResult: true,
    async onError(pageError) {
      const specialError = options.resolveSpecialError(pageError);
      if (specialError) {
        return options.renderPageSpecialError(specialError);
      }

      // Non-special probe failures (for example use() outside React's render
      // cycle or client references executing on the server) are expected here.
      // The real RSC/SSR render path will surface those properly below.
      return null;
    },
    probePage: options.probePage,
    runWithSuppressedHookWarning(probe) {
      return options.runWithSuppressedHookWarning(probe);
    },
  });

  return { response: pageResponse, layoutFlags };
}
