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
import { isDangerousScheme } from "./url-safety.js";
import { toSameOriginPath } from "./url-utils.js";

// Re-export useActionState from React 19 to match Next.js's next/form module
export { useActionState };

type FormSubmitter = HTMLButtonElement | HTMLInputElement;
const SUPPORTED_FORM_ENCTYPE = "application/x-www-form-urlencoded";
const SUPPORTED_FORM_METHOD = "GET";
const SUPPORTED_FORM_TARGET = "_self";

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
  const formEncType = submitter.getAttribute("formenctype");
  if (formEncType !== null && formEncType !== SUPPORTED_FORM_ENCTYPE) {
    console.error(
      `<Form>'s \`encType\` was set to an unsupported value via \`formEncType="${formEncType}"\`. ` +
        `This will disable <Form>'s navigation functionality. If you need this, use a native <form> element instead.`,
    );
    return true;
  }

  const formMethod = submitter.getAttribute("formmethod");
  if (formMethod !== null && formMethod.toUpperCase() !== SUPPORTED_FORM_METHOD) {
    console.error(
      `<Form>'s \`method\` was set to an unsupported value via \`formMethod="${formMethod}"\`. ` +
        `This will disable <Form>'s navigation functionality. If you need this, use a native <form> element instead.`,
    );
    return true;
  }

  const formTarget = submitter.getAttribute("formtarget");
  if (formTarget !== null && formTarget !== SUPPORTED_FORM_TARGET) {
    console.error(
      `<Form>'s \`target\` was set to an unsupported value via \`formTarget="${formTarget}"\`. ` +
        `This will disable <Form>'s navigation functionality. If you need this, use a native <form> element instead.`,
    );
    return true;
  }

  return false;
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

interface FormProps extends FormHTMLAttributes<HTMLFormElement> {
  /** Target URL for GET forms, or server action for POST forms */
  action: string | ((formData: FormData) => void | Promise<void>);
  /** Replace instead of push in history (default: false) */
  replace?: boolean;
  /** Scroll to top after navigation (default: true) */
  scroll?: boolean;
}

const Form = forwardRef(function Form(props: FormProps, ref: ForwardedRef<HTMLFormElement>) {
  const { action, replace = false, scroll = true, onSubmit, ...rest } = props;

  // If action is a function (server action), pass it directly to React
  if (typeof action === "function") {
    return <form ref={ref} action={action as any} onSubmit={onSubmit as any} {...rest} />;
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
    return <form ref={ref} onSubmit={onSubmit as any} {...rest} />;
  }

  async function handleSubmit(e: any) {
    // Call user's onSubmit first
    if (onSubmit) {
      (onSubmit as any)(e);
      if (e.defaultPrevented) return;
    }

    const submitter = getSubmitter(e.nativeEvent);
    if (submitter && hasUnsupportedSubmitterAttributes(submitter)) {
      return;
    }

    // Only intercept GET forms for client-side navigation
    const method = getEffectiveMethod(submitter, rest.method);
    if (method !== "GET") return;

    const effectiveAction = getEffectiveAction(submitter, action as string);
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
      // App Router: RSC navigation. Await so scroll happens after new content renders.
      if (replace) {
        window.history.replaceState(null, "", url);
      } else {
        window.history.pushState(null, "", url);
      }
      await window.__VINEXT_RSC_NAVIGATE__(url);
    } else {
      // Pages Router: use router or fallback
      if (replace) {
        window.history.replaceState({}, "", url);
      } else {
        window.history.pushState({}, "", url);
      }
      window.dispatchEvent(new PopStateEvent("popstate"));
    }

    if (scroll) {
      window.scrollTo(0, 0);
    }
  }

  return <form ref={ref} action={action} onSubmit={handleSubmit} {...rest} />;
});

export default Form;
