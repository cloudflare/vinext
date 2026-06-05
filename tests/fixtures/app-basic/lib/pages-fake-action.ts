"use server";

// This file is imported from pages/action-import-test.tsx — a Pages Router
// page that does NOT support Server Actions. With the RSC plugin active
// (app-basic fixture has both app/ and pages/), the `"use server"` directive
// would normally cause this file to be transformed into a server-reference
// proxy. For Pages Router we need vinext to keep it as a normal module so
// `actionFoo()` returns the real string.
//
// Regression test for issue #1476:
// https://github.com/cloudflare/vinext/issues/1476
// Mirrors Next.js fixture
// test/e2e/app-dir/action-in-pages-router/actions.ts
export async function actionFoo() {
  return "action:foo";
}
