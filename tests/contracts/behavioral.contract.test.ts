import { describe, it, expect, afterAll } from "vitest";
import { getContractServer, closeContractServer } from "./_helpers";

describe("behavioral contracts", () => {
  afterAll(async () => {
    await closeContractServer();
  });

  // Contract 1: redirect() in server action returns 303
  // Next.js uses 303 See Other for server action redirects (action-handler.ts:1182).
  // This ensures vinext matches that behavior rather than using 307.
  it("redirect() in server action returns 303 status", async () => {
    const { baseUrl } = await getContractServer();

    // First, get the page to extract the server action ID from the rendered HTML.
    // The RSC plugin embeds action IDs as hidden inputs: $ACTION_ID_<referenceId>
    const pageRes = await fetch(`${baseUrl}/contracts/redirect-from-action`);
    const html = await pageRes.text();

    // Extract the action reference ID from the hidden input's name attribute.
    // Format: <input type="hidden" name="$ACTION_ID_/app/.../page.tsx#$$hoist_0_doRedirect"/>
    const actionIdMatch = html.match(/\$ACTION_ID_([^"]+)/);
    expect(actionIdMatch).not.toBeNull();
    const actionId = actionIdMatch![1];

    // Submit the action via POST with x-rsc-action header.
    // vinext uses x-rsc-action (not Next-Action) to identify the action.
    const res = await fetch(`${baseUrl}/contracts/redirect-from-action`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "x-rsc-action": actionId,
        Accept: "text/x-component",
        Origin: baseUrl,
      },
      body: "[]",
      redirect: "manual",
    });

    // Server action redirects return 200 with x-action-redirect-status header
    // (the redirect is handled client-side, not via HTTP redirect).
    const redirectStatus = res.headers.get("x-action-redirect-status");
    expect(redirectStatus).toBe("303");
    expect(res.headers.get("x-action-redirect")).toContain("/about");
  });

  // Contract 2: cookies() is mutable in route handlers
  it("cookies() is mutable in route handler", async () => {
    const { baseUrl } = await getContractServer();
    const res = await fetch(`${baseUrl}/contracts/api/cookies-mutable`);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toContain("contract-test=value");
  });

  // Contract 3: headers() is read-only during render
  it("headers() is read-only in route handler render context", async () => {
    const { baseUrl } = await getContractServer();
    const res = await fetch(`${baseUrl}/contracts/api/headers-readonly`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.readonlyEnforced).toBe(true);
  });

  // Contract 4: Middleware response headers propagate to final response
  // The middleware sets x-mw-ran and x-mw-pathname as response headers via
  // NextResponse.next(). These should be merged into the final HTTP response.
  it("middleware response headers propagate to final response", async () => {
    const { baseUrl } = await getContractServer();
    const res = await fetch(`${baseUrl}/contracts/api/middleware-headers`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mw-ran")).toBe("true");
    expect(res.headers.get("x-mw-pathname")).toBe("/contracts/api/middleware-headers");
  });

  // Contract 5: generateMetadata() title template merging
  it("metadata title template is applied from parent layout", async () => {
    const { baseUrl } = await getContractServer();
    const res = await fetch(`${baseUrl}/contracts/metadata-merge`);
    const html = await res.text();
    expect(html).toContain("Merge Test | Contracts");
  });
});
