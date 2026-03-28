/**
 * OpenNext Compat: next/after deferred work timing tests.
 *
 * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/after.test.ts
 * Tests: ON-7 in TRACKING.md
 *
 * OpenNext verifies that after() schedules deferred work that executes AFTER
 * the response is sent. The test confirms:
 * 1. The POST response is immediate (< 2s even though after() does 2s of work)
 * 2. The counter is NOT updated immediately after POST
 * 3. The counter IS updated after the after() delay completes
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("next/after deferred work (OpenNext compat)", () => {
  test("after() runs deferred work after response is sent", async ({ request }) => {
    // Ref: opennextjs-cloudflare after.test.ts "Next after"
    test.setTimeout(30_000);

    // Get the initial counter value
    const initialRes = await request.get(`${BASE}/api/after-test`);
    expect(initialRes.status()).toBe(200);
    const initialData = await initialRes.json();
    const initialCounter = initialData.counter;

    // Fire POST — should respond immediately, with after() doing work in background
    const dateNow = Date.now();
    const postRes = await request.post(`${BASE}/api/after-test`);
    expect(postRes.status()).toBe(200);
    const postData = await postRes.json();
    expect(postData.success).toBe(true);

    // The POST should respond quickly (< 2s), NOT wait for after() to complete
    // Ref: opennextjs-cloudflare after.test.ts "This request should take less than 5 seconds to respond"
    expect(Date.now() - dateNow).toBeLessThan(2000);

    // Counter should NOT be updated yet (after() is still running)
    // Ref: opennextjs-cloudflare after.test.ts "We want to immediately check"
    const notUpdatedRes = await request.get(`${BASE}/api/after-test`);
    expect(notUpdatedRes.status()).toBe(200);
    const notUpdatedData = await notUpdatedRes.json();
    expect(notUpdatedData.counter).toBe(initialCounter);

    // Wait for after() to complete (2s delay + buffer)
    // Ref: opennextjs-cloudflare after.test.ts "We then wait for 5 seconds"
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Counter should now be updated
    const updatedRes = await request.get(`${BASE}/api/after-test`);
    expect(updatedRes.status()).toBe(200);
    const updatedData = await updatedRes.json();
    expect(updatedData.counter).toBe(initialCounter + 1);
  });
});
