import type { NextRouter } from "vinext/shims/router";

type PagesGetInitialPropsContext = {
  req?: unknown;
  res?: unknown;
  err?: unknown;
  pathname?: string;
  query?: Record<string, unknown>;
  asPath?: string;
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
} & Record<string, unknown>;

export type PagesGetInitialPropsRouter = Omit<
  Pick<NextRouter, "route" | "pathname" | "query" | "asPath">,
  "query"
> & {
  query: Record<string, unknown>;
};

/**
 * Build the URL-state subset of Next.js's ServerRouter used by isolated
 * initial-props helpers. Real request handlers pass their full `next/router`
 * instance; this fallback keeps direct helper callers and tests aligned with
 * the same required fields.
 */
export function createPagesGetInitialPropsRouter(
  pathname: string,
  query: Record<string, unknown>,
  asPath: string,
): PagesGetInitialPropsRouter {
  return {
    // Mirrors Next.js ServerRouter: render.tsx removes one trailing slash and
    // preserves `/` for the root route.
    route: pathname.replace(/\/$/, "") || "/",
    pathname,
    query,
    asPath,
  };
}

type PagesGetInitialProps = (context: PagesGetInitialPropsContext) => unknown;

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isPagesGetInitialProps(value: unknown): value is PagesGetInitialProps {
  return typeof value === "function";
}

function getObjectProperty(target: unknown, property: string): unknown {
  if (!isObjectLike(target)) return undefined;
  return Reflect.get(target, property);
}

function getDisplayName(component: unknown): string {
  const displayName = getObjectProperty(component, "displayName");
  if (typeof displayName === "string" && displayName.length > 0) return displayName;

  const name = getObjectProperty(component, "name");
  if (typeof name === "string" && name.length > 0) return name;

  return "Component";
}

function getInitialPropsFn(component: unknown): PagesGetInitialProps | null {
  const getInitialProps = getObjectProperty(component, "getInitialProps");
  return isPagesGetInitialProps(getInitialProps) ? getInitialProps : null;
}

export function hasPagesGetInitialProps(component: unknown): boolean {
  return getInitialPropsFn(component) !== null;
}

export function isResponseSent(res: unknown): boolean {
  return (
    getObjectProperty(res, "headersSent") === true ||
    getObjectProperty(res, "writableEnded") === true
  );
}

function isPropsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeInitialPropsValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (typeof value === "symbol")
    return value.description ? `Symbol(${value.description})` : "Symbol()";
  if (typeof value === "function") return `[function ${getDisplayName(value)}]`;
  return Object.prototype.toString.call(value);
}

export async function loadPagesGetInitialProps(
  component: unknown,
  context: PagesGetInitialPropsContext,
): Promise<Record<string, unknown> | null> {
  const getInitialProps = getInitialPropsFn(component);
  if (!getInitialProps) return null;

  const result = await Promise.resolve(getInitialProps.call(component, context));
  if (isResponseSent(context.res)) {
    return isPropsObject(result) ? result : {};
  }

  if (!isPropsObject(result)) {
    throw new Error(
      `"${getDisplayName(
        component,
      )}.getInitialProps()" should resolve to an object. But found "${describeInitialPropsValue(
        result,
      )}" instead.`,
    );
  }

  return result;
}

/**
 * Decision returned by {@link loadDevAppInitialProps}.
 *
 * - `skip`: the custom `App` has no `getInitialProps`; the caller renders with
 *   its existing props unchanged.
 * - `response-sent`: `_app.getInitialProps` ended the response itself (wrote
 *   headers / body); the caller must stop and not render.
 * - `render`: the caller should render with the returned `pageProps` /
 *   `renderProps`.
 */
export type DevAppInitialPropsResult =
  | { kind: "skip" }
  | { kind: "response-sent" }
  | {
      kind: "render";
      pageProps: Record<string, unknown>;
      renderProps: Record<string, unknown> & { pageProps?: unknown };
    };

export type DevAppInitialPropsContext = {
  appComponent: unknown;
  /**
   * Builds the `AppTree` element passed to `getInitialProps`. Injected so this
   * module stays free of React; the dev SSR handler supplies the real
   * `React.createElement` closure.
   */
  appTree: (appTreeProps: Record<string, unknown>) => unknown;
  component: unknown;
  req: unknown;
  res: unknown;
  pathname: string;
  query: Record<string, unknown>;
  asPath: string;
  /** The request-scoped `next/router` server instance when available. */
  router?: PagesGetInitialPropsRouter;
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
};

/**
 * Run the custom `App`'s `getInitialProps` for the dev SSR render path and
 * return a decision the caller applies.
 *
 * This is the dev-server counterpart to the production page-data resolver's
 * app-initial-props loading. It is invoked lazily — only when a request is
 * actually going to render (cache miss / on-demand revalidation), never on an
 * ISR cache HIT/STALE that serves cached HTML verbatim — so userland `App`
 * data code does not run on the cache hot path.
 */
export async function loadDevAppInitialProps(
  ctx: DevAppInitialPropsContext,
): Promise<DevAppInitialPropsResult> {
  if (!hasPagesGetInitialProps(ctx.appComponent)) {
    return { kind: "skip" };
  }

  const initialProps = await loadPagesGetInitialProps(ctx.appComponent, {
    AppTree: ctx.appTree,
    Component: ctx.component,
    router: ctx.router ?? createPagesGetInitialPropsRouter(ctx.pathname, ctx.query, ctx.asPath),
    ctx: {
      req: ctx.req,
      res: ctx.res,
      pathname: ctx.pathname,
      query: ctx.query,
      asPath: ctx.asPath,
      locale: ctx.locale,
      locales: ctx.locales,
      defaultLocale: ctx.defaultLocale,
    },
  });

  if (isResponseSent(ctx.res)) {
    return { kind: "response-sent" };
  }

  // Post-guard, loadPagesGetInitialProps always resolves to an object (it only
  // returns null when getInitialProps is absent, excluded above). Preserve the
  // raw `pageProps` value in the App envelope; derive an object-safe projection
  // only for merging data-function props and direct page rendering.
  const initialPageProps = isPropsObject(initialProps) ? initialProps.pageProps : undefined;
  const pageProps = isPropsObject(initialPageProps) ? initialPageProps : {};
  const renderProps = isPropsObject(initialProps) ? initialProps : {};
  return { kind: "render", pageProps, renderProps };
}
