import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RSC_PREWARM_MANIFEST_META_NAME } from "../packages/vinext/src/client/rsc-prewarm-eligibility.js";
import {
  getRscPrewarmManifestMetaHtml,
  injectRscPrewarmManifestMeta,
  injectRscPrewarmManifestMetaHtml,
  removeRscPrewarmManifestInvalidatedHeaders,
} from "../packages/vinext/src/server/app-rsc-prewarm-meta.js";

const META_URL = "/assets/rsc-prewarm-manifest.abc123.json";

function textStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

beforeEach(() => {
  vi.stubGlobal("__VINEXT_RSC_PREWARM_MANIFEST_URL", META_URL);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RSC prewarm manifest meta", () => {
  it("fails closed when the manifest URL is missing and escapes attribute values", () => {
    vi.stubGlobal("__VINEXT_RSC_PREWARM_MANIFEST_URL", undefined);
    expect(getRscPrewarmManifestMetaHtml()).toBe("");
    expect(injectRscPrewarmManifestMetaHtml("<html><head></head></html>")).toBe(
      "<html><head></head></html>",
    );

    vi.stubGlobal("__VINEXT_RSC_PREWARM_MANIFEST_URL", '/asset?x=<tag>&quote="yes"');
    expect(getRscPrewarmManifestMetaHtml()).toContain(
      'content="/asset?x=&lt;tag&gt;&amp;quote=&quot;yes&quot;"',
    );
  });

  it("removes representation validators invalidated by HTML injection", () => {
    const headers = new Headers({ "Content-Length": "123", ETag: '"before"' });

    removeRscPrewarmManifestInvalidatedHeaders(headers);

    expect(headers.get("Content-Length")).toBeNull();
    expect(headers.get("ETag")).toBeNull();
  });

  it("injects before a split uppercase closing head tag", async () => {
    const output = await readText(
      injectRscPrewarmManifestMeta(
        textStream(["<!doctype html><HTML><HEAD><title>x</title></HE", "AD><body>x"]),
      ),
    );

    const meta = `<meta name="${RSC_PREWARM_MANIFEST_META_NAME}" content="${META_URL}">`;
    expect(output).toBe(`<!doctype html><HTML><HEAD><title>x</title>${meta}</HEAD><body>x`);
  });

  it("leaves a stream without a closing head tag unchanged", async () => {
    const html = "<!doctype html><html><body>fragment only</body></html>";
    await expect(readText(injectRscPrewarmManifestMeta(textStream([html])))).resolves.toBe(html);
  });

  it("does not duplicate an existing manifest meta tag in string HTML", () => {
    const meta = getRscPrewarmManifestMetaHtml();
    const html = `<html><head>${meta}</head><body></body></html>`;

    expect(injectRscPrewarmManifestMetaHtml(html)).toBe(html);
    expect(
      injectRscPrewarmManifestMetaHtml(html).match(new RegExp(RSC_PREWARM_MANIFEST_META_NAME, "g")),
    ).toHaveLength(1);
  });

  it("replaces a stale manifest meta tag in string HTML", () => {
    const html = `<html><head><meta name="${RSC_PREWARM_MANIFEST_META_NAME}" content="/old.json"></head><body></body></html>`;

    const output = injectRscPrewarmManifestMetaHtml(html);

    expect(output).toContain(`content="${META_URL}"`);
    expect(output).not.toContain("/old.json");
  });

  it("removes a stale manifest meta tag when eligibility is empty", () => {
    vi.stubGlobal("__VINEXT_RSC_PREWARM_MANIFEST_URL", undefined);
    const html = `<html><head><meta name="${RSC_PREWARM_MANIFEST_META_NAME}" content="/old.json"></head><body></body></html>`;

    expect(injectRscPrewarmManifestMetaHtml(html)).toBe("<html><head></head><body></body></html>");
  });

  it("does not duplicate an existing manifest meta tag in streamed HTML", async () => {
    const meta = getRscPrewarmManifestMetaHtml();
    const html = `<html><head>${meta}</head><body></body></html>`;
    const splitAt = html.indexOf(RSC_PREWARM_MANIFEST_META_NAME) + 8;
    const output = await readText(
      injectRscPrewarmManifestMeta(textStream([html.slice(0, splitAt), html.slice(splitAt)])),
    );

    expect(output).toBe(html);
    expect(output.match(new RegExp(RSC_PREWARM_MANIFEST_META_NAME, "g"))).toHaveLength(1);
  });

  it("replaces a stale manifest meta tag in streamed HTML", async () => {
    const html = `<html><head><meta name="${RSC_PREWARM_MANIFEST_META_NAME}" content="/old.json"></head><body></body></html>`;

    const output = await readText(injectRscPrewarmManifestMeta(textStream([html])));

    expect(output).toContain(`content="${META_URL}"`);
    expect(output).not.toContain("/old.json");
  });

  it("ignores closing-head text inside inline scripts", async () => {
    const html = `<html><head><script>const marker = "</head>"</script></head><body></body></html>`;
    const output = injectRscPrewarmManifestMetaHtml(html);

    expect(output).toContain(`<script>const marker = "</head>"</script>`);
    expect(output).toContain(`</script>${getRscPrewarmManifestMetaHtml()}</head>`);
  });

  it("waits for a split raw-text element before finding the streamed head close", async () => {
    const html = `<html><head><script>const marker = "</head>"</script></head><body></body></html>`;
    const splitAt = html.indexOf("</script>");
    const output = await readText(
      injectRscPrewarmManifestMeta(textStream([html.slice(0, splitAt), html.slice(splitAt)])),
    );

    expect(output).toContain(`<script>const marker = "</head>"</script>`);
    expect(output).toContain(`</script>${getRscPrewarmManifestMetaHtml()}</head>`);
  });
});
