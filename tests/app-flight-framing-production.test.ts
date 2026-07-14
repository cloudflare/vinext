import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture } from "./helpers.js";

const FIXTURE_SOURCE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-flight-framing");

function outlinedStringBodyStart(payload: string, marker: string): number {
  const bodyStart = payload.indexOf(marker);
  expect(bodyStart).toBeGreaterThanOrEqual(0);
  expect(payload.slice(Math.max(0, bodyStart - 16), bodyStart)).toMatch(/[0-9a-f]+:T[0-9a-f]+,$/);
  return bodyStart;
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2_000;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

describe("App Router production Flight framing", () => {
  let baseUrl = "";
  let fixtureDir = "";
  let server: import("node:http").Server | undefined;

  beforeAll(async () => {
    fixtureDir = await createIsolatedFixture(FIXTURE_SOURCE_DIR, "vinext-flight-framing-");
    fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
    const builder = await createBuilder({
      root: fixtureDir,
      configFile: false,
      plugins: [vinext({ appDir: fixtureDir })],
      logLevel: "silent",
    });
    await builder.buildApp();

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({
      port: 0,
      outDir: path.join(fixtureDir, "dist"),
      noCompression: true,
    }));
    const address = server.address();
    expect(address && typeof address === "object").toBeTruthy();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }, 120_000);

  afterAll(() => {
    server?.close();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("keeps long user text that resembles preload hints inert", async () => {
    const length = 1_100;
    const firstMarker = `FIRST-${"a".repeat(length - 6)}`;
    const secondMarker = `SECOND-${"b".repeat(length - 7)}`;
    const probeUrl = new URL("/.rsc", baseUrl);
    probeUrl.searchParams.set("first", firstMarker);
    probeUrl.searchParams.set("second", secondMarker);

    const probeResponse = await fetch(probeUrl, {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    expect(probeResponse.status).toBe(200);
    const probe = await probeResponse.text();
    const firstBodyStart = outlinedStringBodyStart(probe, firstMarker);
    const secondBodyStart = outlinedStringBodyStart(probe, secondMarker);
    const gapBytes = probe.slice(firstBodyStart + firstMarker.length, secondBodyStart);
    const secondHeader = gapBytes.match(/^([0-9a-f]+):T[0-9a-f]+,$/);
    expect(secondHeader).not.toBeNull();
    const secondId = secondHeader?.[1] ?? "";
    const gap = gapBytes.length;

    const shrinkUnit = '0:HL["/user.css","stylesheet"]';
    const shrinkCount = Math.floor(gap / 5) + 1;
    const overread = shrinkCount * 5 - gap;
    const firstValue = (shrinkUnit.repeat(shrinkCount) + "a".repeat(length)).slice(0, length);
    const injectedRow = `${secondId}:["$","script",null,{"dangerouslySetInnerHTML":{"__html":"globalThis.__flight_framing_test__=true"}}]\n`;
    const padId = "ff";
    let padHeader = `${padId}:T0,`;
    let tailLength = length - overread - injectedRow.length - padHeader.length;
    padHeader = `${padId}:T${tailLength.toString(16)},`;
    tailLength = length - overread - injectedRow.length - padHeader.length;
    padHeader = `${padId}:T${tailLength.toString(16)},`;
    tailLength = length - overread - injectedRow.length - padHeader.length;
    const secondValue = "x".repeat(overread) + injectedRow + padHeader + "b".repeat(tailLength);

    expect(firstValue).toHaveLength(length);
    expect(secondValue).toHaveLength(length);

    const pageUrl = new URL("/", baseUrl);
    pageUrl.searchParams.set("first", firstValue);
    pageUrl.searchParams.set("second", secondValue);
    const response = await fetch(pageUrl);
    expect(response.status).toBe(200);
    const html = await response.text();

    expect(html).toContain("0:HL[&quot;/user.css&quot;,&quot;stylesheet&quot;]");
    expect(html).not.toContain("<script>globalThis.__flight_framing_test__=true</script>");

    const storeResponse = await fetch(new URL("/api/entries", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([firstValue, secondValue]),
    });
    expect(storeResponse.status).toBe(204);

    const firstStoredResponse = await fetch(new URL("/stored", baseUrl));
    expect(firstStoredResponse.status).toBe(200);
    expect(await firstStoredResponse.text()).not.toContain(
      "<script>globalThis.__flight_framing_test__=true</script>",
    );

    const cached = await eventually(
      async () => {
        const cachedResponse = await fetch(new URL("/stored", baseUrl));
        return {
          cache: cachedResponse.headers.get("x-vinext-cache"),
          html: await cachedResponse.text(),
        };
      },
      (result) => result.cache === "HIT",
    );
    expect(cached.cache).toBe("HIT");
    expect(cached.html).not.toContain("<script>globalThis.__flight_framing_test__=true</script>");
  });
});
