import { patternToNextFormat } from "../routing/route-validation.js";
import { deferUntilStreamConsumed } from "./defer-until-stream-consumed.js";
import { frameworkTracer } from "./tracer.js";

type PagesDataMethod = "getServerSideProps" | "getStaticProps";

export function createPagesDataSpanDescriptor(method: PagesDataMethod, routePattern: string) {
  const route = patternToNextFormat(routePattern);
  return {
    attributes: { "next.route": route },
    name: `${method} ${route}`,
    type: `Render.${method}`,
  } as const;
}

export function tracePagesData<T>(
  method: PagesDataMethod,
  routePattern: string,
  callback: () => T,
): T {
  return frameworkTracer.trace(createPagesDataSpanDescriptor(method, routePattern), callback);
}

export function createPagesDocumentSpanDescriptor(routePattern: string) {
  const route = patternToNextFormat(routePattern);
  return {
    attributes: { "next.route": route },
    name: `render route (pages) ${route}`,
    type: "Render.renderDocument",
  } as const;
}

export function tracePagesDocument<T>(routePattern: string, callback: () => T): T {
  return frameworkTracer.trace(createPagesDocumentSpanDescriptor(routePattern), callback);
}

type PagesDocumentStreamResult = {
  bodyStream?: ReadableStream<Uint8Array>;
  waitForBody?: boolean;
};

/** Return at shell readiness while keeping the span open through body rendering. */
export function tracePagesDocumentStream<T extends PagesDocumentStreamResult>(
  routePattern: string,
  callback: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const traced = tracePagesDocument(routePattern, async () => {
      try {
        let result = await callback();
        if (!result.waitForBody || !result.bodyStream) {
          resolve(result);
          return result;
        }

        let finish!: () => void;
        let fail!: (error: unknown) => void;
        const completion = new Promise<void>((resolveCompletion, rejectCompletion) => {
          finish = resolveCompletion;
          fail = rejectCompletion;
        });
        result = {
          ...result,
          bodyStream: deferUntilStreamConsumed(result.bodyStream, finish, fail),
        };
        resolve(result);
        await completion;
        return result;
      } catch (error) {
        reject(error);
        throw error;
      }
    });
    void traced.catch(() => {});
  });
}

export function createPagesApiHandlerSpanDescriptor(routePattern: string) {
  const route = patternToNextFormat(routePattern);
  return {
    name: `executing api route (pages) ${route}`,
    type: "Node.runHandler",
  } as const;
}

export function tracePagesApiHandler<T>(
  routePattern: string,
  callback: () => T,
  options: { recordErrors?: boolean } = {},
): T {
  return frameworkTracer.trace(
    { ...createPagesApiHandlerSpanDescriptor(routePattern), recordErrors: options.recordErrors },
    callback,
  );
}

export function createFindPageComponentsSpanDescriptor(routePattern: string) {
  return {
    attributes: { "next.route": patternToNextFormat(routePattern) },
    name: "resolve page components",
    type: "NextNodeServer.findPageComponents",
  } as const;
}

export function traceFindPageComponents<T>(routePattern: string, callback: () => T): T {
  return frameworkTracer.trace(createFindPageComponentsSpanDescriptor(routePattern), callback);
}

// Next.js 16.4 traces loading the page's own module inside
// `findPageComponents` (`loadRouteModule` in server/load-components.ts) and
// the route module's request preparation (`RouteModule.prepare` in
// server/route-modules/route-module.ts) on every request.
const LOAD_ROUTE_MODULE_SPAN = {
  name: "load route module",
  type: "LoadComponents.loadRouteModule",
} as const;

const PREPARE_ROUTE_MODULE_SPAN = {
  name: "prepare route module",
  type: "RouteModule.prepare",
} as const;

export function createLoadRouteModuleSpanDescriptor() {
  return LOAD_ROUTE_MODULE_SPAN;
}

export function createPrepareRouteModuleSpanDescriptor() {
  return PREPARE_ROUTE_MODULE_SPAN;
}

/** Resolve the page's own module, beneath its `findPageComponents` span. */
export function traceLoadRouteModule<T>(callback: () => T): T {
  return frameworkTracer.trace(LOAD_ROUTE_MODULE_SPAN, callback);
}

/** Set up the matched route's request context (pathname, query, params). */
export function tracePrepareRouteModule<T>(callback: () => T): T {
  return frameworkTracer.trace(PREPARE_ROUTE_MODULE_SPAN, callback);
}
