import { workUnitAsyncStorage } from "vinext/shims/internal/work-unit-async-storage";
import { runWithGenerateStaticParamsRootParams } from "vinext/shims/root-params";
import {
  closeAfterResponse,
  runWithUnifiedStateMutation,
  type UnifiedRequestContext,
} from "vinext/shims/unified-request-context";
import { resolveAppRouteHandlerFetchCacheMode } from "./app-segment-config.js";
import { buildAppStaticParamsTags } from "./implicit-tags.js";
import { patternToNextRoute } from "../routing/route-pattern.js";

/**
 * Runs a route's generateStaticParams as Next.js does, in a work store of its
 * own: root params come only from parent params, which a route handler's
 * generator has none of, request APIs throw because there is no request, and
 * its fetches leave the request's tags, revalidate and dynamic-usage
 * observations alone. A metadata route's generateSitemaps and
 * generateImageMetadata run the same way, through the generateStaticParams
 * Next.js' metadata loader gives the route.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/static-paths/app.ts
 */
export function runStaticParamsGeneration<T>(
  handler: { fetchCache?: unknown },
  pattern: string,
  routeSegments: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  // Like Next.js' AfterRunner, the generator's after() work finishes before
  // its params are used, and a failed task fails the generation.
  const afterPromises: Promise<unknown>[] = [];
  let afterTaskError: { error: unknown } | null = null;
  let generatorContext: UnifiedRequestContext | undefined;
  const generate = async () => {
    let result: T;
    try {
      // Next.js' generate-static-params work unit, where io() resolves and
      // a root param getter fails: these generators have no parent params.
      result = await workUnitAsyncStorage.run({ type: "generate-static-params" }, () =>
        runWithGenerateStaticParamsRootParams(patternToNextRoute(pattern), {}, [], fn),
      );
    } catch (error) {
      // Next.js never runs a failed generator's after() callbacks, also those
      // its after() promises register later. Drop them, so the request's
      // waitUntil doesn't wait on them.
      if (generatorContext) {
        generatorContext.afterContext.cancelled = true;
        generatorContext.afterContext.callbacks.length = 0;
        void closeAfterResponse(generatorContext);
      }
      throw error;
    }
    if (generatorContext) {
      await closeAfterResponse(generatorContext);
      while (afterPromises.length > 0) {
        await Promise.all(afterPromises.splice(0));
        await closeAfterResponse(generatorContext);
      }
    }
    if (afterTaskError) throw afterTaskError.error;
    return result;
  };
  return runWithUnifiedStateMutation((ctx) => {
    generatorContext = ctx;
    ctx.afterContext = {
      callbacks: [],
      responseClosed: false,
      pendingCallbacks: 0,
      pendingPromises: 0,
      completion: null,
      resolveCompletion: null,
      waitUntil: (promise) => afterPromises.push(promise),
      onTaskError: (error) => {
        afterTaskError ??= { error };
      },
    };
    ctx.rootParams = {};
    ctx.currentRequestTags = [];
    // Next.js' implicit tags name the route handler, not the request's pathname.
    ctx.currentFetchSoftTags = buildAppStaticParamsTags(routeSegments, "route");
    ctx.dynamicFetchUrls = new Set<string>();
    // Like a page's check, the generator memoizes its own fetches, whichever
    // branch runs it. Next.js' build store reads cached data even during an
    // on-demand revalidation.
    ctx.isFetchDedupeActive = true;
    ctx.currentFetchDedupeEntries = new Map();
    ctx.nextFetchId = 1;
    ctx.isOnDemandRevalidate = false;
    // `cacheForRequest()` and "use cache: private" values belong to the
    // request, not the generator.
    ctx.requestCache = new WeakMap();
    ctx._privateCache = new Map();
    ctx.headersContext = {
      headers: new Headers(),
      cookies: new Map(),
      staticParamsRoute: pattern,
      accessError: new Error(
        `Route ${pattern} used a request API such as \`headers()\`, \`cookies()\`, \`connection()\` or \`draftMode()\` inside \`generateStaticParams\`. ` +
          "This is not supported because `generateStaticParams` runs at build time without an HTTP request. " +
          "Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context",
      ),
    };
    ctx.dynamicUsageDetected = false;
    ctx.renderDynamicLatch = { dynamic: false, listeners: new Set() };
    ctx.renderRequestApiUsage = new Set();
    // Next.js applies only the segment's fetchCache to the generator.
    ctx.currentFetchCacheMode = resolveAppRouteHandlerFetchCacheMode(handler);
    ctx.currentFetchRevalidate = null;
    ctx.currentForceDynamicFetchDefault = false;
  }, generate);
}
