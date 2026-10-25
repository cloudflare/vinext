import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import {
  probeAppPageLayouts,
  type AppPageSpecialError,
  type LayoutClassificationOptions,
  type LayoutFlags,
} from "./app-page-execution.js";
import { isPromiseLike } from "../utils/promise.js";

const DEFAULT_SUBTREE_PROBE_MAX_DEPTH = 32;
const DEFAULT_SUBTREE_PROBE_MAX_NODES = 1000;
const REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref");
const REACT_LAZY_TYPE = Symbol.for("react.lazy");
const REACT_MEMO_TYPE = Symbol.for("react.memo");
const REACT_CLIENT_REFERENCE_TYPE = Symbol.for("react.client.reference");

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

function isReactClientReference(value: unknown): boolean {
  return isObjectLike(value) && Reflect.get(value, "$$typeof") === REACT_CLIENT_REFERENCE_TYPE;
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

    if (isReactClientReference(type)) {
      return false;
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

type ProbeAppPageBeforeRenderResult = {
  response: Response | null;
  layoutFlags: LayoutFlags;
};

type ProbeAppPageBeforeRenderOptions = {
  skipProbes?: boolean;
  layoutCount: number;
  probeLayoutAt: (layoutIndex: number) => unknown;
  renderLayoutSpecialError: (
    specialError: AppPageSpecialError,
    layoutIndex: number,
  ) => Promise<Response>;
  resolveSpecialError: (error: unknown) => AppPageSpecialError | null;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
  /** When provided, enables per-layout static/dynamic classification. */
  classification?: LayoutClassificationOptions | null;
};

export async function probeAppPageBeforeRender(
  options: ProbeAppPageBeforeRenderOptions,
): Promise<ProbeAppPageBeforeRenderResult> {
  let layoutFlags: LayoutFlags = {};

  if (options.skipProbes) {
    return { response: null, layoutFlags };
  }

  // A layout's special error renders the boundary above that layout, so it is
  // resolved before the render.
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

  // The page itself is never probed. As in Next.js, its redirect() and
  // notFound() come from the render: before the first byte for HTML, and as a
  // Flight digest the client router handles for RSC.
  return { response: null, layoutFlags };
}
