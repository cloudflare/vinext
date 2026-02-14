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
  type FormHTMLAttributes,
  type ForwardedRef,
} from "react";

interface FormProps extends FormHTMLAttributes<HTMLFormElement> {
  /** Target URL for GET forms, or server action for POST forms */
  action: string | ((formData: FormData) => void | Promise<void>);
  /** Replace instead of push in history (default: false) */
  replace?: boolean;
  /** Scroll to top after navigation (default: true) */
  scroll?: boolean;
}

const Form = forwardRef(function Form(
  props: FormProps,
  ref: ForwardedRef<HTMLFormElement>,
) {
  const { action, replace = false, scroll = true, onSubmit, ...rest } = props;

  // If action is a function (server action), pass it directly to React
  if (typeof action === "function") {
    return <form ref={ref} action={action as any} onSubmit={onSubmit as any} {...rest} />;
  }

  function handleSubmit(e: any) {
    // Call user's onSubmit first
    if (onSubmit) {
      (onSubmit as any)(e);
      if (e.defaultPrevented) return;
    }

    // Only intercept GET forms for client-side navigation
    const method = (rest.method ?? "GET").toUpperCase();
    if (method !== "GET") return;

    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    const params = new URLSearchParams();
    for (const [key, value] of formData) {
      if (typeof value === "string") {
        params.append(key, value);
      }
    }

    const url = `${action}?${params.toString()}`;

    // Navigate client-side
    const win = window as any;
    if (typeof win.__NEXTCOMPAT_RSC_NAVIGATE__ === "function") {
      // App Router: RSC navigation
      if (replace) {
        window.history.replaceState(null, "", url);
      } else {
        window.history.pushState(null, "", url);
      }
      win.__NEXTCOMPAT_RSC_NAVIGATE__(url);
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

  return (
    <form
      ref={ref}
      action={action}
      onSubmit={handleSubmit}
      {...rest}
    />
  );
});

export default Form;
