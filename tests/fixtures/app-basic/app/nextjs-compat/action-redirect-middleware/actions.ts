"use server";

import { redirect } from "next/navigation";

/**
 * Redirects to `/admin`, which this fixture's middleware blocks with a 403.
 * A redirecting action renders its target inline, so the target's middleware
 * has to run before that render or the blocked page's payload leaks into the
 * action response.
 */
export async function redirectToBlockedPath(): Promise<void> {
  redirect("/admin");
}

/**
 * Percent-encoded alias of the same blocked path. Route matching that decodes
 * would resolve this to the `/admin` page, while middleware and a real
 * navigation both see `/adm%69n`. Deliberately not `/%61dmin`, which this
 * fixture's middleware rewrites — a rewrite already forces a real navigation,
 * which would hide whether the target was matched with request identity.
 */
export async function redirectToEncodedBlockedPath(): Promise<void> {
  redirect("/adm%69n");
}

export async function redirectToMiddlewareRewrite(): Promise<void> {
  redirect("/middleware-rewrite");
}

export async function redirectToConfigRewrite(): Promise<void> {
  redirect("/config-rewrite");
}

export async function redirectToMiddlewareRedirect(): Promise<void> {
  redirect("/middleware-redirect");
}

export async function redirectToConfigRedirect(): Promise<void> {
  redirect("/redirect-test-config");
}

export async function redirectToAbout(): Promise<void> {
  redirect("/about");
}

export async function redirectToPagesRoute(): Promise<void> {
  redirect("/old-school");
}
