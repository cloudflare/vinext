import { expect, type APIRequest } from "@playwright/test";

const PROMOTION_STABILITY_WINDOW_MS = 60_000;
const PROMOTION_READINESS_TIMEOUT_MS = 120_000;
const PROMOTION_PROBE_INTERVAL_MS = 1_000;

export async function waitForStablePromotion({
  baseURL,
  buildId,
  playwright,
  rscBuildId,
}: {
  baseURL: string;
  buildId: string;
  playwright: { request: APIRequest };
  rscBuildId: string;
}): Promise<void> {
  const deadline = Date.now() + PROMOTION_READINESS_TIMEOUT_MS;
  let attempt = 0;
  let lastFailure: unknown;
  let stableSince: number | undefined;

  while (Date.now() < deadline) {
    const probeId = `${Date.now()}-${attempt++}`;
    const probeRequest = await playwright.request.newContext();
    try {
      const versionUrl = new URL("/api/prewarm-version", baseURL);
      versionUrl.searchParams.set("readiness", probeId);
      const versionResponse = await probeRequest.get(versionUrl.href, { timeout: 5_000 });
      expect(versionResponse.ok()).toBe(true);
      expect(versionResponse.headers()["cache-control"]).toContain("no-store");
      expect(await versionResponse.json()).toEqual({ buildId, rscBuildId });

      stableSince ??= Date.now();
      if (Date.now() - stableSince >= PROMOTION_STABILITY_WINDOW_MS) {
        return;
      }
    } catch (error) {
      lastFailure = error;
      stableSince = undefined;
    } finally {
      await probeRequest.dispose();
    }

    await new Promise((resolve) => setTimeout(resolve, PROMOTION_PROBE_INTERVAL_MS));
  }

  throw new Error(
    `Worker promotion did not remain stable for ${PROMOTION_STABILITY_WINDOW_MS}ms: ${String(lastFailure)}`,
  );
}
