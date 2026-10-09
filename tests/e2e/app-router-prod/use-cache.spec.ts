import { createHash } from "node:crypto";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// plugin-rsc's production reference key is a public function of the module
// path, so these are the identities an attacker can derive offline.
function derivedReferenceKey(modulePath: string): string {
  return createHash("sha256").update(modulePath).digest("hex").slice(0, 12);
}

const recordsKey = derivedReferenceKey("app/use-cache-hidden-reference/records.ts");
const inlineRecordsKey = derivedReferenceKey("app/use-cache-hidden-reference/inline-records.ts");

const HIDDEN_CACHE_HELPERS = [
  { actionId: `${recordsKey}#readRecord`, secret: "VICTIM_PRIVATE_RECORD" },
  { actionId: `${recordsKey}#default`, secret: "VICTIM_DEFAULT_PRIVATE_RECORD" },
  {
    actionId: `${inlineRecordsKey}#readInlineRecord`,
    secret: "VICTIM_INLINE_PRIVATE_RECORD",
  },
  {
    actionId: `${inlineRecordsKey}#$$hoist_0_readInlineRecord`,
    secret: "VICTIM_INLINE_PRIVATE_RECORD",
  },
] as const;

test.describe('production "use cache" server function references', () => {
  // Next.js only makes a "use cache" function remotely callable through a
  // build-salted server-reference id that never reaches a client unless the
  // function itself does. A server-only cache helper must not be callable
  // through an id derived from its source path and export name, whichever
  // way the action request is sent.
  // https://github.com/vercel/next.js/blob/canary/crates/next-custom-transforms/src/transforms/server_actions.rs
  test("serves server-only cache helpers only through the page's authorization check", async ({
    request,
  }) => {
    const anonymous = await request.get("/use-cache-hidden-reference?record=victim");
    expect(anonymous.status()).toBe(200);
    const anonymousHtml = await anonymous.text();
    expect(anonymousHtml).toContain("FORBIDDEN");
    expect(anonymousHtml).not.toMatch(/VICTIM_\w*PRIVATE_RECORD/);

    for (const [source, secret] of [
      ["named", "VICTIM_PRIVATE_RECORD"],
      ["default", "VICTIM_DEFAULT_PRIVATE_RECORD"],
      ["inline", "VICTIM_INLINE_PRIVATE_RECORD"],
    ] as const) {
      const victim = await request.get(
        `/use-cache-hidden-reference?record=victim&source=${source}`,
        {
          headers: { Authorization: "Bearer fixture-victim-session" },
        },
      );
      expect(victim.status()).toBe(200);
      expect(await victim.text()).toContain(secret);
    }
  });

  for (const { actionId, secret } of HIDDEN_CACHE_HELPERS) {
    test(`rejects a Next-Action request for derived id ${actionId}`, async ({ request }) => {
      const exploit = await request.post("/use-cache-hidden-reference", {
        data: JSON.stringify(["victim"]),
        headers: {
          Accept: "text/x-component",
          "Content-Type": "text/plain;charset=UTF-8",
          "Next-Action": actionId,
        },
      });

      expect(exploit.status()).toBe(404);
      expect(exploit.headers()["x-nextjs-action-not-found"]).toBe("1");
      expect(await exploit.text()).not.toContain(secret);
    });

    test(`rejects an RSC action request for derived id ${actionId}`, async ({ request }) => {
      const exploit = await request.post("/use-cache-hidden-reference.rsc", {
        data: JSON.stringify(["victim"]),
        headers: { "Content-Type": "text/plain", "x-rsc-action": actionId },
      });

      expect(exploit.status()).toBe(404);
      expect(exploit.headers()["x-nextjs-action-not-found"]).toBe("1");
      expect(await exploit.text()).not.toContain(secret);
    });

    test(`rejects a progressive form action for derived id ${actionId}`, async ({ request }) => {
      const exploit = await request.post("/use-cache-hidden-reference", {
        // Playwright drops empty multipart fields; the action id is read only
        // from the field name.
        multipart: { [`$ACTION_ID_${actionId}`]: "1", id: "victim" },
      });

      expect(exploit.status()).toBe(404);
      expect(exploit.headers()["x-nextjs-action-not-found"]).toBe("1");
      expect(await exploit.text()).not.toContain(secret);
    });
  }

  // Like Next.js, closure values reach the client only as captures encrypted
  // for that function (use-cache-wrapper.ts `boundArgsLength`, encryption.ts
  // `actionId`). The reference id is public in the page payload, so invoking
  // it with forged, missing or another function's captures must not run it.
  test("rejects forged captures for inline cache functions passed to Client Components", async ({
    baseURL,
    page,
    request,
  }) => {
    const captureAction = async (button: string) => {
      const [action] = await Promise.all([
        page.waitForRequest(
          (candidate) => candidate.method() === "POST" && !!candidate.headers()["x-rsc-action"],
        ),
        page.locator(button).click(),
      ]);
      return {
        id: action.headers()["x-rsc-action"]!,
        contentType: action.headers()["content-type"]!,
        body: action.postDataBuffer()!,
      };
    };

    await page.context().addCookies([{ name: "tenant", value: "acme", url: baseURL! }]);
    await page.goto("/use-cache-capture-integrity");
    await expect(page.locator("#tenant")).toHaveText("acme");
    await waitForAppRouterHydration(page);
    const getOrders = await captureAction("#load-orders");
    await expect(page.locator("#orders")).toHaveText("ACME_PRIVATE_ORDER");

    // Any visitor can obtain captures holding a value they chose.
    await page.context().clearCookies();
    await page.goto("/use-cache-capture-integrity?label=acme");
    await expect(page.locator("#tenant")).toHaveText("anonymous");
    await waitForAppRouterHydration(page);
    const echoLabel = await captureAction("#echo-label");
    await expect(page.locator("#label")).toHaveText("acme");
    expect(echoLabel.id).not.toBe(getOrders.id);

    // No session cookie: the request context is separate from the page's.
    const invokeGetOrders = (data: string | Buffer, contentType = "text/plain;charset=UTF-8") =>
      request.post("/use-cache-capture-integrity", {
        data,
        headers: {
          Accept: "text/x-component",
          "Content-Type": contentType,
          "x-rsc-action": getOrders.id,
        },
      });
    for (const forged of [
      await invokeGetOrders(JSON.stringify([["acme"], ""])),
      await invokeGetOrders(JSON.stringify([])),
      await invokeGetOrders(echoLabel.body, echoLabel.contentType),
    ]) {
      expect(forged.status()).toBe(500);
      expect(await forged.text()).not.toContain("ACME_PRIVATE_ORDER");
    }

    // Control: the genuine encrypted captures still decrypt for this function.
    const genuine = await invokeGetOrders(getOrders.body, getOrders.contentType);
    expect(genuine.status()).toBe(200);
    expect(await genuine.text()).toContain("ACME_PRIVATE_ORDER");
  });

  test("invokes default-exported server actions from cached modules", async ({ page }) => {
    await page.goto("/use-cache-client-import");
    await waitForAppRouterHydration(page);

    await page.locator("#call-client-imported-default").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("1");
    await expect(page.getByTestId("client-imported-cache-result")).toHaveText(
      "client-default:direct",
    );
  });

  test("separates arguments for file-level cached exports imported by a Client Component", async ({
    page,
  }) => {
    await page.goto("/use-cache-client-import");
    await waitForAppRouterHydration(page);

    await page.locator("#call-client-imported-cache").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("1");
    await expect(page.getByTestId("client-imported-cache-result")).toHaveText(
      /^client-cache:direct:[0-9.e+-]+$/,
    );
    const directResult = await page.getByTestId("client-imported-cache-result").innerText();

    await page.locator("#call-client-imported-cache-other").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("2");
    await expect(page.getByTestId("client-imported-cache-result")).toHaveText(
      /^client-cache:other:[0-9.e+-]+$/,
    );
    const otherResult = await page.getByTestId("client-imported-cache-result").innerText();
    expect(otherResult).not.toBe(directResult);

    await page.locator("#call-client-imported-cache").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("3");
    await expect(page.getByTestId("client-imported-cache-result")).toHaveText(directResult);

    await page.locator("#call-client-imported-server").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("4");
    await expect(page.getByTestId("client-imported-cache-result")).toHaveText(
      /^client-server:direct:[0-9.e+-]+$/,
    );
    const firstServerResult = await page.getByTestId("client-imported-cache-result").innerText();

    await page.locator("#call-client-imported-server").click();
    await expect(page.getByTestId("client-imported-cache-call-count")).toHaveText("5");
    await expect(page.getByTestId("client-imported-cache-result")).not.toHaveText(
      firstServerResult,
    );
  });

  test("runs inline use-server and use-cache exports owned by different plugins", async ({
    page,
  }) => {
    await page.goto("/use-cache-mixed-ownership");
    await expect(page.getByTestId("use-cache-mixed-ownership-page")).toBeVisible();
    await waitForAppRouterHydration(page);

    await page.locator("#call-mixed-builtin").click();
    await expect(page.getByTestId("mixed-builtin-call-count")).toHaveText("1");
    await expect(page.getByTestId("mixed-builtin-result")).toHaveText("builtin");

    await page.locator("#call-mixed-flexible").click();
    await expect(page.getByTestId("mixed-flexible-call-count")).toHaveText("1");
    const cachedResult = await page.getByTestId("mixed-flexible-result").innerText();
    expect(cachedResult).toMatch(/^cached:[0-9.e+-]+$/);

    await page.locator("#call-mixed-flexible").click();
    await expect(page.getByTestId("mixed-flexible-call-count")).toHaveText("2");
    await expect(page.getByTestId("mixed-flexible-result")).toHaveText(cachedResult);
  });

  test('caches an inline "use cache" function during server render inside a file-level "use server" module', async ({
    page,
  }) => {
    await page.goto("/use-cache-transform-coverage");

    const aggregateResult = await page.getByTestId("use-cache-transform-coverage").innerText();
    const serverResult = aggregateResult.split("|")[1];
    if (!serverResult) throw new Error("Missing server-boundary result");
    expect(serverResult).toMatch(/^server-boundary:[0-9.e+-]+$/);

    await page.reload();
    const repeatedResult = await page.getByTestId("use-cache-transform-coverage").innerText();
    expect(repeatedResult.split("|")[1]).toBe(serverResult);
  });

  test("replays cached RSC through SSR and invokes nested functions from the browser", async ({
    page,
  }) => {
    await page.goto("/use-cache-nested-fn-props");
    await expect(page.getByTestId("use-cache-nested-fn-props-page")).toBeVisible();
    const cachedRender = await page.getByTestId("nested-cache-render").textContent();

    // Force a second server request so this test exercises the cache-hit Flight
    // replay path before invoking the nested references in the browser.
    await page.reload();
    await expect(page.getByTestId("use-cache-nested-fn-props-page")).toBeVisible();
    await expect(page.getByTestId("nested-cache-render")).toHaveText(cachedRender!);
    await waitForAppRouterHydration(page);

    await page.locator("#submit-button-date").click();
    await expect(page.locator("#date")).toHaveText(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const firstDate = await page.locator("#date").textContent();
    await page.locator("#submit-button-date").click();
    await expect(page.locator("#date")).toHaveText(firstDate!);

    await page.locator("#submit-button-random").click();
    await expect(page.locator("#random")).toHaveText(/^\d+\.\d+$/);
    const firstRandom = await page.locator("#random").textContent();
    await page.locator("#submit-button-random").click();
    await expect(page.locator("#random")).toHaveText(firstRandom!);

    await page.locator("#submit-button-message").click();
    await expect(page.locator("#message")).toHaveText(
      /^message:closure-captured-bound-arg-vinext:[0-9.e+-]+$/,
    );
    const firstMessage = await page.locator("#message").textContent();
    await page.locator("#submit-button-message").click();
    await expect(page.locator("#message")).toHaveText(firstMessage!);

    await page.locator("#submit-button-message-other").click();
    await expect(page.locator("#message-other")).toHaveText(
      /^message:closure-captured-bound-arg-other:[0-9.e+-]+$/,
    );
    const otherMessage = await page.locator("#message-other").textContent();
    expect(otherMessage).not.toBe(firstMessage);
    await page.locator("#submit-button-message-other").click();
    await expect(page.locator("#message-other")).toHaveText(otherMessage!);
  });

  // Next.js passes a cached component's children as temporary references: the
  // entry stores a reference, and a hit renders the current request's children.
  test.describe("cached wrapper with request-specific children", () => {
    const SECRETS = ["ALICE_PRIVATE_SECRET", "BOB_PRIVATE_SECRET", "PUBLIC_GUEST"];
    const visit = async (request: APIRequestContext, partition: string, session?: string) => {
      const response = await request.get(
        `/use-cache-passthrough-children?partition=${partition}`,
        session ? { headers: { Cookie: `session=${session}` } } : {},
      );
      expect(response.status()).toBe(200);
      const html = await response.text();
      const text = (id: string) => html.match(new RegExp(`id="${id}">([^<]*)<`))?.[1];
      const result = {
        viewer: text("viewer"),
        secret: text("secret"),
        wrapper: text("wrapper-generated"),
      };
      expect(result.wrapper).toMatch(/^[0-9.e+-]+$/);
      // Covers the inline Flight payload as well as the HTML.
      for (const secret of SECRETS) {
        if (secret !== result.secret) expect(html).not.toContain(secret);
      }
      return result;
    };

    test("does not replay an authenticated visitor's children to later visitors", async ({
      request,
    }) => {
      const partition = `alice-first-${Date.now()}`;
      const alice = await visit(request, partition, "alice");
      expect(alice).toMatchObject({ viewer: "alice", secret: "ALICE_PRIVATE_SECRET" });

      expect(await visit(request, partition)).toEqual({
        viewer: "guest",
        secret: "PUBLIC_GUEST",
        wrapper: alice.wrapper,
      });
      expect(await visit(request, partition, "bob")).toEqual({
        viewer: "bob",
        secret: "BOB_PRIVATE_SECRET",
        wrapper: alice.wrapper,
      });
    });

    test("does not replay a guest's children to a later authenticated visitor", async ({
      request,
    }) => {
      const partition = `guest-first-${Date.now()}`;
      const guest = await visit(request, partition);
      expect(guest).toMatchObject({ viewer: "guest", secret: "PUBLIC_GUEST" });

      expect(await visit(request, partition, "alice")).toEqual({
        viewer: "alice",
        secret: "ALICE_PRIVATE_SECRET",
        wrapper: guest.wrapper,
      });
    });
  });
});
