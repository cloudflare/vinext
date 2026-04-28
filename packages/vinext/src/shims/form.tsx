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

import { forwardRef, useActionState, type FormHTMLAttributes, type ForwardedRef } from "react";
import { navigateClientSide } from "./navigation.js";
import { isDangerousScheme } from "./url-safety.js";
import { hasBasePath } from "../utils/base-path.js";
import { toSameOriginPath } from "./url-utils.js";

// Re-export useActionState from React 19 to match Next.js's next/form module
export { useActionState };

type FormSubmitter = (HTMLButtonElement | HTMLInputElement) & {
  disabled?: boolean;
  formEnctype?: string;
  formMethod?: string;
  formTarget?: string;
  name?: string;
  value?: string;
  getAttribute(name: string): string | null;
};
const SUPPORTED_FORM_ENCTYPE = "application/x-www-form-urlencoded";
const SUPPORTED_FORM_METHOD = "GET";
const SUPPORTED_FORM_TARGET = "_self";

function getBasePath(): string {
  return process.env.__NEXT_ROUTER_BASEPATH ?? "";
}

function isSafeAction(action: string): boolean {
  // Block dangerous URI schemes
  if (isDangerousScheme(action)) return false;
  // Block protocol-relative URLs (//evil.com/...)
  if (action.startsWith("//")) return false;
  // Block absolute URLs to external origins (client-side: compare origins)
  if (/^https?:\/\//i.test(action)) {
    if (typeof window !== "undefined") {
      try {
        const actionUrl = new URL(action);
        return actionUrl.origin === window.location.origin;
      } catch {
        return false;
      }
    }
    // Server-side: block all absolute URLs (can't compare origins)
    return false;
  }
  return true;
}

function isFormSubmitter(value: unknown): value is FormSubmitter {
  return (
    value !== null &&
    typeof value === "object" &&
    "getAttribute" in value &&
    typeof value.getAttribute === "function"
  );
}

function getSubmitter(
  nativeEvent: unknown,
  form: HTMLFormElement,
  fallbackSubmitter: FormSubmitter | null,
): FormSubmitter | null {
  const submitter =
    nativeEvent &&
    typeof nativeEvent === "object" &&
    "submitter" in nativeEvent &&
    isFormSubmitter(nativeEvent.submitter)
      ? nativeEvent.submitter
      : null;

  if (submitter) return submitter;

  const activeElement = typeof document !== "undefined" ? document.activeElement : null;
  if (isFormSubmitter(activeElement) && form.contains(activeElement as Node)) {
    return activeElement;
  }

  if (fallbackSubmitter) return fallbackSubmitter;

  return null;
}

function getEffectiveMethod(
  submitter: FormSubmitter | null,
  formMethod: FormHTMLAttributes<HTMLFormElement>["method"],
): string {
  const override = submitter?.getAttribute("formmethod");
  return (override ?? formMethod ?? "GET").toUpperCase();
}

function getEffectiveAction(submitter: FormSubmitter | null, formAction: string): string {
  return submitter?.getAttribute("formaction") ?? formAction;
}

function addBasePathToFormAction(action: string): string {
  const basePath = getBasePath();
  if (!basePath || !action.startsWith("/") || action.startsWith("//")) return action;

  try {
    const url = new URL(action, "http://vinext.local");
    if (url.origin !== "http://vinext.local" || hasBasePath(url.pathname, basePath)) {
      return action;
    }
    return `${basePath}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return action;
  }
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

function getSubmitterAttribute(
  submitter: FormSubmitter,
  lowerName: string,
  reactName: string,
): string | null {
  return submitter.getAttribute(lowerName) ?? submitter.getAttribute(reactName);
}

function hasUnsupportedSubmitterAttributes(submitter: FormSubmitter): boolean {
  const formEncType =
    getSubmitterAttribute(submitter, "formenctype", "formEncType") ??
    (submitter.formEnctype && submitter.formEnctype !== SUPPORTED_FORM_ENCTYPE
      ? submitter.formEnctype
      : null);
  if (formEncType !== null && formEncType !== SUPPORTED_FORM_ENCTYPE) {
    console.error(
      `<Form>'s \`encType\` was set to an unsupported value via \`formEncType="${formEncType}"\`. ` +
        `This will disable <Form>'s navigation functionality. If you need this, use a native <form> element instead.`,
    );
    return true;
  }

  const formMethod =
    getSubmitterAttribute(submitter, "formmethod", "formMethod") ??
    (submitter.formMethod && submitter.formMethod.toUpperCase() !== SUPPORTED_FORM_METHOD
      ? submitter.formMethod
      : null);
  if (formMethod !== null && formMethod.toUpperCase() !== SUPPORTED_FORM_METHOD) {
    console.error(
      `<Form>'s \`method\` was set to an unsupported value via \`formMethod="${formMethod}"\`. ` +
        `This will disable <Form>'s navigation functionality. If you need this, use a native <form> element instead.`,
    );
    return true;
  }

  const formTarget =
    getSubmitterAttribute(submitter, "formtarget", "formTarget") ??
    (submitter.formTarget && submitter.formTarget !== SUPPORTED_FORM_TARGET
      ? submitter.formTarget
      : null);
  if (formTarget !== null && formTarget !== SUPPORTED_FORM_TARGET) {
    console.error(
      `<Form>'s \`target\` was set to an unsupported value via \`formTarget="${formTarget}"\`. ` +
        `This will disable <Form>'s navigation functionality. If you need this, use a native <form> element instead.`,
    );
    return true;
  }

  return false;
}

function hasUnsupportedSubmitterFallback(form: HTMLFormElement): boolean {
  if (typeof form.querySelectorAll !== "function") return false;

  for (const element of form.querySelectorAll("button,input")) {
    if (isFormSubmitter(element) && hasUnsupportedSubmitterAttributes(element)) {
      return true;
    }
  }
  return false;
}

function hasReactClientActionAttributes(submitter: FormSubmitter): boolean {
  const action = submitter.getAttribute("formaction") ?? submitter.getAttribute("formAction");
  return action !== null && /^\s*javascript:/i.test(action);
}

function createFormSubmitDestinationUrl(
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
    targetUrl.searchParams.append(name, typeof value === "string" ? value : value.name);
  }

  // When a basePath-prefixed action/formAction resolves to a browser URL,
  // hand the absolute URL to navigateClientSide so it can normalize back to
  // an app-relative route before re-applying basePath. Returning "/base/..."
  // here would be treated as app-relative and become "/base/base/...".
  const basePath = getBasePath();
  if (basePath && hasBasePath(targetUrl.pathname, basePath)) {
    return targetUrl.href;
  }

  return toSameOriginPath(targetUrl.href) ?? targetUrl.href;
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
  /** Disable automatic loading-state prefetch behavior */
  prefetch?: false | null;
  /** Replace instead of push in history (default: false) */
  replace?: boolean;
  /** Scroll to top after navigation (default: true) */
  scroll?: boolean;
} & FormHTMLAttributes<HTMLFormElement>;

const Form = forwardRef(function Form(props: FormProps, ref: ForwardedRef<HTMLFormElement>) {
  const {
    action,
    prefetch = null,
    replace = false,
    scroll = true,
    onSubmit,
    onClickCapture,
    ...rest
  } = props;
  let capturedSubmitter: FormSubmitter | null = null;
  let didPrefetchLoading = false;

  function setFormRef(element: HTMLFormElement | null): void {
    if (typeof ref === "function") {
      ref(element);
    } else if (ref) {
      ref.current = element;
    }

    if (
      element &&
      !didPrefetchLoading &&
      typeof action === "string" &&
      prefetch !== false &&
      isSafeAction(action) &&
      typeof window !== "undefined" &&
      typeof window.__VINEXT_RSC_PREFETCH_LOADING__ === "function"
    ) {
      didPrefetchLoading = true;
      void window.__VINEXT_RSC_PREFETCH_LOADING__(action);
    }
  }

  // If action is a function (server action), pass it directly to React
  if (typeof action === "function") {
    return (
      <form
        ref={setFormRef}
        action={action}
        onSubmit={onSubmit}
        onClickCapture={onClickCapture}
        {...rest}
      />
    );
  }

  // Block dangerous action URLs. Render <form> without action attribute
  // so it submits to the current page (safe default).
  if (process.env.NODE_ENV !== "production") {
    checkFormActionUrl(action, "action");
  }

  if (!isSafeAction(action)) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`<Form> blocked unsafe action: ${action}`);
    }
    return <form ref={setFormRef} onSubmit={onSubmit} {...rest} />;
  }

  const actionHref = addBasePathToFormAction(action);

  async function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    // Call user's onSubmit first
    if (onSubmit) {
      onSubmit(e);
      if (e.defaultPrevented) return;
    }

    const submitter = getSubmitter(e.nativeEvent, e.currentTarget, capturedSubmitter);
    if (submitter && hasUnsupportedSubmitterAttributes(submitter)) {
      return;
    }
    if (!submitter && hasUnsupportedSubmitterFallback(e.currentTarget)) {
      return;
    }
    if (submitter && hasReactClientActionAttributes(submitter)) {
      return;
    }

    // Only intercept GET forms for client-side navigation
    const method = getEffectiveMethod(submitter, rest.method);
    if (method !== "GET") return;

    const effectiveAction = getEffectiveAction(submitter, actionHref);
    if (process.env.NODE_ENV !== "production" && submitter?.getAttribute("formaction") !== null) {
      checkFormActionUrl(effectiveAction, "formAction");
    }
    if (!isSafeAction(effectiveAction)) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`<Form> blocked unsafe action: ${effectiveAction}`);
      }
      e.preventDefault();
      return;
    }

    e.preventDefault();
    const url = createFormSubmitDestinationUrl(effectiveAction, e.currentTarget, submitter);

    // Navigate client-side
    if (typeof window.__VINEXT_RSC_NAVIGATE__ === "function") {
      // App Router: use the shared navigator so URL/history publish stays
      // aligned with the committed RSC tree.
      await navigateClientSide(
        url,
        replace ? "replace" : "push",
        scroll,
        prefetch !== false,
        prefetch === false,
      );
    } else {
      // Pages Router: use router or fallback
      if (replace) {
        window.history.replaceState({}, "", url);
      } else {
        window.history.pushState({}, "", url);
      }
      window.dispatchEvent(new PopStateEvent("popstate"));
    }

    // App Router: scroll is handled inside navigateClientSide (called above).
    // Pages Router: scroll manually since pushState/popstate doesn't auto-scroll.
    if (typeof window.__VINEXT_RSC_NAVIGATE__ !== "function" && scroll) {
      window.scrollTo(0, 0);
    }
  }

  function handleClickCapture(e: React.MouseEvent<HTMLFormElement>) {
    const target = e.target;
    if (isFormSubmitter(target) && e.currentTarget.contains(target)) {
      capturedSubmitter = target;
    }
    onClickCapture?.(e);
  }

  return (
    <form
      ref={setFormRef}
      action={actionHref}
      onSubmit={handleSubmit}
      onClickCapture={handleClickCapture}
      {...rest}
    />
  );
});

export default Form;
