import { test, expect } from "@playwright/test";
import { defineNitroAppTests } from "./app-tests";

// examples/app-router-nitro served by `vite dev`, where Nitro replaces the
// rsc dev environment with one that has no module runner (#853). The
// workspace installs `next`, so this also covers vinext's next/navigation
// shim loading instead of real Next.js in Nitro's dev environments.

test.describe("App Router on Nitro (vite dev)", () => {
  defineNitroAppTests();

  // Nitro passes requests it does not serve, such as missing assets, back to
  // Vite. @vitejs/plugin-rsc's dev handler must not take those requests, or
  // they fail with a 500 in `environment.runner.import()`.
  test("responds 404 to a missing image", async ({ request }) => {
    const response = await request.get("/missing.png", {
      headers: { "sec-fetch-dest": "image" },
    });
    expect(response.status()).toBe(404);
  });
});
