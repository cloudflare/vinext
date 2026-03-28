"use client";
import { useRouter } from "next/compat/router";

/**
 * A component shared between the App Router and Pages Router.
 * Uses next/compat/router so it works in both contexts:
 *   - Pages Router: useRouter() returns the router object
 *   - App Router: useRouter() returns null
 */
export default function CompatRouterWidget() {
  const router = useRouter();

  if (router === null) {
    return (
      <div data-testid="compat-router-widget">
        <span data-testid="router-context">app-router</span>
      </div>
    );
  }

  return (
    <div data-testid="compat-router-widget">
      <span data-testid="router-context">pages-router</span>
      <span data-testid="router-pathname">{router.pathname}</span>
    </div>
  );
}
