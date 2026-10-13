import { expect, test, type Page, type Request } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

type CapturedAction = { headers: Record<string, string>; body: string };

async function captureAction(page: Page, button: string, result: string): Promise<CapturedAction> {
  const requestPromise = page.waitForRequest(
    (request: Request) => request.method() === "POST" && "next-action" in request.headers(),
  );
  await page.click(button);
  const request = await requestPromise;
  await expect(page.locator("#result")).toHaveText(result);
  return { headers: await request.allHeaders(), body: request.postData() ?? "" };
}

test.describe("Server Action bound arguments", () => {
  // Next.js encrypts an inline action's closure with its action id as a prefix
  // and rejects any payload whose prefix differs, so a closure issued for one
  // action can never be decrypted as another action's captures.
  // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/app-render/encryption.ts
  test("rejects one action's encrypted closure replayed into another action", async ({ page }) => {
    await page.goto("/action-bound-args?label=admin");
    await waitForAppRouterHydration(page);

    const preview = await captureAction(page, "#preview", "PREVIEW:admin");
    const readSecret = await captureAction(page, "#read-secret", "DENIED:viewer");
    expect(preview.headers["next-action"]).not.toBe(readSecret.headers["next-action"]);

    // Keep readSecret's action id, but send a captured body as-is (with its
    // own content type, which carries the multipart boundary).
    const sendAsReadSecret = (captured: CapturedAction) =>
      page.request.post("/action-bound-args?label=admin", {
        headers: {
          accept: "text/x-component",
          "content-type": captured.headers["content-type"],
          "next-action": readSecret.headers["next-action"],
          origin: new URL(page.url()).origin,
        },
        data: captured.body,
      });

    const control = await sendAsReadSecret(readSecret);
    expect(control.status()).toBe(200);
    expect(await control.text()).toContain("DENIED:viewer");

    const replay = await sendAsReadSecret(preview);
    const replayBody = await replay.text();
    expect(replayBody).not.toContain("BOUND_ARGS_SECRET");
    expect(replayBody).not.toContain("DENIED:");
    expect(replay.status()).toBe(500);
  });
});
