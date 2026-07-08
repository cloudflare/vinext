"use client";

/**
 * next/form shim
 *
 * Progressive enhancement form component. In Next.js, this replaces
 * the standard <form> element with one that intercepts submissions
 * and performs client-side navigation for GET forms (search forms).
 *
 * For POST forms with server actions, it delegates to React's built-in
 * form action handling.
 *
 * Usage:
 *   import Form from 'next/form';
 *   <Form action="/search">
 *     <input name="q" />
 *     <button type="submit">Search</button>
 *   </Form>
 */

import {
  forwardRef,
  useActionState,
  useCallback,
  useEffect,
  useRef,
  type FormHTMLAttributes,
  type ForwardedRef,
} from "react";
import { hasAppNavigationRuntime } from "../client/navigation-runtime.js";
import { useMergedRef } from "./use-merged-ref.js";
import {
  getMountedSlotsHeader,
  getPrefetchInterceptionContext,
  getPrefetchedUrls,
  hasPrefetchCacheEntryForNavigation,
  navigateClientSide,
  prefetchRscResponse,
} from "./navigation.js";
import { assertSafeNavigationUrl } from "./url-safety.js";
import { withBasePath } from "./url-utils.js";
import { createRscRequestHeaders, createRscRequestUrl } from "../server/app-rsc-cache-busting.js";
import { APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL } from "../server/app-rsc-render-mode.js";
import { AppElementsWire } from "../server/app-elements.js";
import { VINEXT_MOUNTED_SLOTS_HEADER } from "../server/headers.js";
import { isBotUserAgent } from "../utils/html-limited-bots.js";

// Mirrors `__NEXT_ROUTER_BASEPATH` exposure in `next/link` / `next/router`.
// `addBasePath` is only applied to the form-level `action` prop. A submitter's
// `formAction` is intentionally untouched, matching Next.js (the comment in
// upstream `form.tsx` notes "this should not have basePath added, because we
// can't add it before hydration").
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";

// Props that <Form> does not allow users to set directly, matching Next.js's
// DISALLOWED_FORM_PROPS in packages/next/src/client/form-shared.tsx.
// These are stripped (with a dev warning) rather than passed to the <form> element.
const DISALLOWED_FORM_PROPS = ["method", "encType", "target"] as const;
type DisallowedFormPropKey = (typeof DISALLOWED_FORM_PROPS)[number];

// Re-export useActionState from React 19 to match Next.js's next/form module
export { useActionState };

type FormSubmitter = HTMLButtonElement | HTMLInputElement;
const SUPPORTED_FORM_ENCTYPE = "application/x-www-form-urlencoded";
const SUPPORTED_FORM_METHOD = "GET";
const SUPPORTED_FORM_TARGET = "_self";

function isPrefetchableAction(action: string): boolean {
  // Browser-only: callers must guard this behind a client environment check.
  try {
    const actionUrl = new URL(action, window.location.href);
    return (
      (actionUrl.protocol === "http:" || actionUrl.protocol === "https:") &&
      actionUrl.origin === window.location.origin
    );
  } catch {
    return false;
  }
}

function getSubmitter(nativeEvent: unknown): FormSubmitter | null {
  const submitter =
    nativeEvent &&
    typeof nativeEvent === "object" &&
    "submitter" in nativeEvent &&
    nativeEvent.submitter instanceof Element
      ? nativeEvent.submitter
      : null;

  if (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) {
    return submitter;
  }
  return null;
}

// A submitter encoding a React Server Action has a `name` like `$ACTION_ID_...`
// or `$ACTION_REF_...`. Such submissions must not be intercepted for GET
// navigation. Ported verbatim from Next.js app-dir/form.tsx.
function hasReactServerActionAttributes(submitter: FormSubmitter): boolean {
  const name = submitter.getAttribute("name");
  return Boolean(name && (name.startsWith("$ACTION_ID_") || name.startsWith("$ACTION_REF_")));
}

// A submitter encoding a React Client Action has `formAction="javascript:..."`.
// We can't prefetch/navigate to that, so bail. Ported from Next.js form-shared.tsx.
function hasReactClientActionAttributes(submitter: FormSubmitter): boolean {
  const action = submitter.getAttribute("formAction");
  return Boolean(action && /\s*javascript:/i.test(action));
}

function getEffectiveAction(submitter: FormSubmitter | null, formAction: string): string {
  return submitter?.getAttribute("formaction") ?? formAction;
}

function checkFormActionUrl(action: string, source: "action" | "formAction"): void {
  const aPropName = source === "action" ? "an `action`" : "a `formAction`";

  let testUrl: URL;
  try {
    testUrl = new URL(action, "http://n");
  } catch {
    console.error(`<Form> received ${aPropName} that cannot be parsed as a URL: "${action}".`);
    return;
  }

  if (testUrl.searchParams.size) {
    console.warn(
      `<Form> received ${aPropName} that contains search params: "${action}". This is not supported, and they will be ignored. ` +
        `If you need to pass in additional search params, use an \`<input type="hidden" />\` instead.`,
    );
  }
}

function hasUnsupportedSubmitterAttributes(submitter: FormSubmitter): boolean {
  // Each warning is gated behind the dev check (matches Next.js form-shared.tsx);
  // the `return true` bail itself runs in all environments.
  const formEncType = submitter.getAttribute("formenctype");
  if (formEncType !== null && formEncType !== SUPPORTED_FORM_ENCTYPE) {
    if (process.env.NODE_ENV !== "production") {
      console.error(
        `<Form>'s \`encType\` was set to an unsupported value via \`formEncType="${formEncType}"\`. ` +
          `This will disable <Form>'s navigation functionality. If you need this, use a native <form> element instead.`,
      );
    }
    return true;
  }

  const formMethod = submitter.getAttribute("formmethod");
  if (formMethod !== null && formMethod.toUpperCase() !== SUPPORTED_FORM_METHOD) {
    if (process.env.NODE_ENV !== "production") {
      console.error(
        `<Form>'s \`method\` was set to an unsupported value via \`formMethod="${formMethod}"\`. ` +
          `This will disable <Form>'s navigation functionality. If you need this, use a native <form> element instead.`,
      );
    }
    return true;
  }

  const formTarget = submitter.getAttribute("formtarget");
  if (formTarget !== null && formTarget !== SUPPORTED_FORM_TARGET) {
    if (process.env.NODE_ENV !== "production") {
      console.error(
        `<Form>'s \`target\` was set to an unsupported value via \`formTarget="${formTarget}"\`. ` +
          `This will disable <Form>'s navigation functionality. If you need this, use a native <form> element instead.`,
      );
    }
    return true;
  }

  return false;
}

export function createFormSubmitDestinationUrl(
  action: string,
  form: HTMLFormElement,
  submitter: FormSubmitter | null,
): string {
  const targetUrl = new URL(action, window.location.href);
  if (targetUrl.searchParams.size) {
    targetUrl.search = "";
  }

  const formData = buildFormData(form, submitter);
  for (const [name, value] of formData) {
    if (typeof value !== "string") {
      // File inputs: use the filename as the value (matches browser behavior).
      // Reference: https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#converting-an-entry-list-to-a-list-of-name-value-pairs
      if (process.env.NODE_ENV !== "production") {
        console.warn(
          `<Form> only supports file inputs if \`action\` is a function. File inputs cannot be used if \`action\` is a string, ` +
            `because files cannot be encoded as search params.`,
        );
      }
      targetUrl.searchParams.append(name, value.name);
    } else {
      targetUrl.searchParams.append(name, value);
    }
  }

  return targetUrl.href;
}

function buildFormData(form: HTMLFormElement, submitter: FormSubmitter | null): FormData {
  if (!submitter) return new FormData(form);

  try {
    return new FormData(form, submitter);
  } catch {
    const formData = new FormData(form);
    if (!submitter.disabled && submitter.name) {
      formData.append(submitter.name, submitter.value);
    }
    return formData;
  }
}

type FormProps = {
  /** Target URL for GET forms, or server action for POST forms */
  action: string | ((formData: FormData) => void | Promise<void>);
  /** Replace instead of push in history (default: false) */
  replace?: boolean;
  /** Scroll to top after navigation (default: true) */
  scroll?: boolean;
  /**
   * Controls whether the form's target URL is prefetched when the form enters
   * the viewport. Only applies to App Router with a string `action`.
   * - `null` (default): prefetch automatically (production only)
   * - `false`: disable prefetching
   *
   * In pages dir, prefetch is not supported and the prop has no effect.
   */
  prefetch?: false | null;
} & Omit<FormHTMLAttributes<HTMLFormElement>, DisallowedFormPropKey>;

const Form = forwardRef(function Form(props: FormProps, ref: ForwardedRef<HTMLFormElement>) {
  const { action, replace = false, scroll = true, prefetch = null, onSubmit, ...rest } = props;

  // Dev-mode validation, ported verbatim from Next.js app-dir/form.tsx.
  // Runs before the DISALLOWED_FORM_PROPS strip to match upstream console-output order.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/app-dir/form.tsx
  const isNavigatingForm = typeof action === "string";
  if (process.env.NODE_ENV !== "production") {
    // Validate `action` first, matching upstream's dev-validation order.
    if (typeof action === "string") {
      checkFormActionUrl(action, "action");
    }
    // Validate `prefetch`: must be `false` or `null` (undefined is the absence
    // of the prop and is allowed). Read the raw prop so the default doesn't mask it.
    if (!(props.prefetch === undefined || props.prefetch === false || props.prefetch === null)) {
      console.error("The `prefetch` prop of <Form> must be `false` or `null`");
    }
    // `prefetch` with a function action has no effect.
    if (props.prefetch !== undefined && !isNavigatingForm) {
      console.error("Passing `prefetch` to a <Form> whose `action` is a function has no effect.");
    }
    // `replace`/`scroll` with a function action have no effect.
    if (!isNavigatingForm && (props.replace !== undefined || props.scroll !== undefined)) {
      console.error(
        "Passing `replace` or `scroll` to a <Form> whose `action` is a function has no effect.\n" +
          "See the relevant docs to learn how to control this behavior for navigations triggered from actions:\n" +
          "  `redirect()`       - https://nextjs.org/docs/app/api-reference/functions/redirect#parameters\n" +
          "  `router.replace()` - https://nextjs.org/docs/app/api-reference/functions/use-router#userouter\n",
      );
    }
  }

  // Strip DISALLOWED_FORM_PROPS and emit dev warnings (matches Next.js form-shared.tsx).
  // Ported from: packages/next/src/client/app-dir/form.tsx (DISALLOWED_FORM_PROPS loop)
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/app-dir/form.tsx
  const cleanRest = { ...rest } as Record<string, unknown>;
  for (const key of DISALLOWED_FORM_PROPS) {
    if (key in cleanRest) {
      if (process.env.NODE_ENV !== "production") {
        console.error(
          `<Form> does not support changing \`${key}\`. ` +
            (isNavigatingForm
              ? `If you'd like to use it to perform a mutation, consider making \`action\` a function instead.\n` +
                `Learn more: https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations`
              : ""),
        );
      }
      delete cleanRest[key];
    }
  }

  // All hooks must be called unconditionally (React Rules of Hooks).
  // These are placed before any conditional return.

  // Merge the forwarded ref with our internal ref for viewport prefetching.
  // Reuse the shared `useMergedRef` helper (same one Next.js's form uses).
  const formRef = useRef<HTMLFormElement | null>(null);
  const setFormRef = useCallback((node: HTMLFormElement | null) => {
    formRef.current = node;
  }, []);
  const setRefs = useMergedRef(setFormRef, ref ?? null);

  // Compute actionHref unconditionally (empty string for function actions — unused).
  const actionHref = typeof action === "string" ? withBasePath(action, __basePath) : "";

  // Viewport-based prefetch: when the form enters the viewport, prefetch the
  // RSC payload for the action URL. App Router only; disabled in dev (matches
  // Next.js behavior). Gated by `prefetch !== false` and string action.
  // Reference: link.tsx IntersectionObserver wiring pattern.
  useEffect(() => {
    if (typeof action !== "string") return;
    if (prefetch === false || process.env.NODE_ENV !== "production") return;
    // External destinations remain valid form markup and native navigation
    // targets, but only same-origin HTTP(S) actions can produce reusable RSC.
    if (!isPrefetchableAction(actionHref)) return;
    if (!hasAppNavigationRuntime()) return;
    const node = formRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting || entry.intersectionRatio > 0) {
            void (async () => {
              if (isBotUserAgent(window.navigator?.userAgent ?? "")) return;

              // Mirror the Link/router prefetch computation so the cache key the
              // navigation later looks up matches what we prefetch here. Without
              // this, intercepted routes or pages with mounted parallel slots
              // would key under a different context and miss the cached payload.
              // (See link.tsx:373-389 and navigation.ts:1909-1916.)
              const interceptionContext = getPrefetchInterceptionContext(actionHref);
              const mountedSlotsHeader = getMountedSlotsHeader();
              const headers = createRscRequestHeaders({
                interceptionContext,
                renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
              });
              if (mountedSlotsHeader) {
                headers.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
              }
              const rscUrl = await createRscRequestUrl(actionHref, headers);
              const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
              // Dedup: skip if already in-flight or a fresh cache entry exists,
              // matching the gate link.tsx applies to avoid double-fetching a
              // payload that a nearby <Link> already prefetched.
              const prefetched = getPrefetchedUrls();
              if (prefetched.has(cacheKey)) return;
              if (
                hasPrefetchCacheEntryForNavigation(rscUrl, interceptionContext, mountedSlotsHeader)
              )
                return;
              prefetched.add(cacheKey);
              const fetchPromise = fetch(rscUrl, {
                headers,
                credentials: "include",
                // Match link.tsx: deprioritize the background prefetch and tag it
                // as a prefetch so it surfaces correctly in devtools / `Sec-Purpose`.
                priority: "low",
                // @ts-expect-error — purpose is a valid fetch option in some browsers
                purpose: "prefetch",
              });
              prefetchRscResponse(
                rscUrl,
                fetchPromise,
                interceptionContext,
                mountedSlotsHeader,
                undefined,
                {
                  cacheForNavigation: false,
                  optimisticRouteShell: true,
                },
              );
            })();
            observer.unobserve(node);
          }
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => {
      observer.unobserve(node);
    };
    // `actionHref` is derived purely from `action` (+ the module-constant
    // `__basePath`), so it's technically redundant alongside `action` here, but
    // exhaustive-deps requires it to be listed since the effect references it.
  }, [action, prefetch, actionHref]);

  // If action is a function (server action), pass it directly to React.
  // Hooks are already called above.
  if (typeof action === "function") {
    return <form ref={setRefs} action={action} onSubmit={onSubmit} {...cleanRest} />;
  }

  function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    // Call user's onSubmit first
    if (onSubmit) {
      onSubmit(e);
      if (e.defaultPrevented) return;
    }

    const submitter = getSubmitter(e.nativeEvent);
    if (submitter) {
      // The way server actions are encoded (e.g. `formMethod="post"`) causes
      // unnecessary dev-mode warnings from `hasUnsupportedSubmitterAttributes`;
      // we'd bail out anyway, so do it silently. (Matches Next.js form.tsx.)
      if (process.env.NODE_ENV !== "production" && hasReactServerActionAttributes(submitter)) {
        return;
      }
      if (hasUnsupportedSubmitterAttributes(submitter)) {
        return;
      }
      // Client actions encode as `formAction="javascript:..."` — can't navigate to that.
      if (hasReactClientActionAttributes(submitter)) {
        return;
      }
    }

    // No explicit GET check needed (matches upstream app-dir/form.tsx): the
    // form-level `method` prop is stripped via DISALLOWED_FORM_PROPS, and any
    // non-GET submitter `formmethod` override is already caught and bailed on by
    // `hasUnsupportedSubmitterAttributes` above. By this point the method is GET.

    // NOTE: a submitter's `formAction` is intentionally NOT base-path-prefixed
    // here, matching Next.js. Upstream `form.tsx` notes: "this should not have
    // `basePath` added, because we can't add it before hydration".
    const effectiveAction = getEffectiveAction(submitter, actionHref);
    if (process.env.NODE_ENV !== "production" && submitter?.getAttribute("formaction") !== null) {
      checkFormActionUrl(effectiveAction, "formAction");
    }
    const url = createFormSubmitDestinationUrl(effectiveAction, e.currentTarget, submitter);
    e.preventDefault();

    // Navigate client-side
    if (hasAppNavigationRuntime()) {
      // App Router: preserve the same dangerous-scheme guard used by
      // router.push()/replace(), then use the shared navigator so URL/history
      // publication stays aligned with the committed RSC tree.
      assertSafeNavigationUrl(url);
      void navigateClientSide(url, replace ? "replace" : "push", scroll);
    } else {
      // Pages Router: delegate to the Router singleton so navigation flows
      // through `performNavigation` (route events, HTML fetch, scroll
      // handling). Mirrors what `<Link>` does at link.tsx:619-623.
      // Keep the shared guard synchronous so React receives the error; the
      // async import fallback below must never turn it into history navigation.
      assertSafeNavigationUrl(url);
      void (async () => {
        let Router: (typeof import("./router.js"))["default"];
        try {
          const routerModule = await import("./router.js");
          Router = routerModule.default;
          if (replace) {
            await Router.replace(url, undefined, { scroll });
          } else {
            await Router.push(url, undefined, { scroll });
          }
        } catch {
          // If the Pages Router cannot load or initialize navigation, use a
          // real document navigation rather than publishing a stale URL via
          // history alone.
          if (replace) {
            window.location.replace(url);
          } else {
            window.location.assign(url);
          }
        }
      })();
    }
  }

  return (
    <form
      ref={setRefs}
      action={actionHref}
      onSubmit={(event) => {
        handleSubmit(event);
      }}
      {...cleanRest}
    />
  );
});

export default Form;
