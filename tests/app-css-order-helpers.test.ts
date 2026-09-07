import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeRscAssetsManifestCssOrderSource,
  reorderClientReferenceCss,
} from "../packages/vinext/src/build/rsc-css-order.js";
import { addRscCssResourceCrossOrigin } from "../packages/vinext/src/plugins/rsc-css-resource-crossorigin.js";
import {
  dedupeGlobalCssOwnerStylesheetLinks,
  inlineStyleCoversStylesheetHref,
  installGlobalCssOwnerStylesheetDedupe,
  removeStylesheetLinksCoveredByInlineCss,
} from "../packages/vinext/src/server/app-inline-css-client.js";

type FakeElement = {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  remove: ReturnType<typeof vi.fn>;
};

function fakeElement(attributes: Record<string, string>): FakeElement {
  return {
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => Object.hasOwn(attributes, name),
    remove: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, Symbol.for("vinext.globalCssOwnerDedupe"));
});

describe("RSC CSS manifest ordering", () => {
  const clientManifest = {
    "app/first.tsx": {
      css: ["assets/first.css"],
      imports: ["app/first-dependency.ts"],
    },
    "app/first-dependency.ts": { css: ["assets/first-dependency.css"] },
    "app/second.tsx": {
      css: ["assets/second.css"],
      imports: ["app/second-dependency.ts"],
    },
    "app/second-dependency.ts": { css: ["assets/second-dependency.css"] },
  };

  it("reorders every client-chunk segment and preserves each segment's hrefs", () => {
    expect(
      reorderClientReferenceCss(
        [
          "/base/assets/first.css?v=1",
          "/base/assets/first-dependency.css?v=1",
          "/base/assets/unrelated.css",
          "/cdn/assets/second.css",
          "/cdn/assets/second-dependency.css",
        ],
        clientManifest,
      ),
    ).toEqual([
      "/base/assets/first-dependency.css?v=1",
      "/base/assets/first.css?v=1",
      "/base/assets/unrelated.css",
      "/cdn/assets/second-dependency.css",
      "/cdn/assets/second.css",
    ]);
  });

  it("normalizes client-reference CSS without changing server resources", () => {
    const source = `export default ${JSON.stringify({
      clientReferenceDeps: {
        reference: {
          css: ["/assets/first.css", "/assets/first-dependency.css"],
        },
      },
      serverResources: {
        resource: {
          css: ["/assets/first.css", "/assets/first-dependency.css"],
        },
      },
    })}`;
    const normalized = normalizeRscAssetsManifestCssOrderSource(source, clientManifest);
    const manifest = JSON.parse(normalized.slice("export default ".length));

    expect(manifest.clientReferenceDeps.reference.css).toEqual([
      "/assets/first-dependency.css",
      "/assets/first.css",
    ]);
    expect(manifest.serverResources.resource.css).toEqual([
      "/assets/first.css",
      "/assets/first-dependency.css",
    ]);
  });

  it("preserves manifests containing runtime asset expressions", () => {
    const source = "export default { css: [globalThis.__assetUrl] }";
    expect(normalizeRscAssetsManifestCssOrderSource(source, clientManifest)).toBe(source);
  });
});

describe("RSC stylesheet resource transform", () => {
  it("adds crossorigin across formatting and identifier changes", () => {
    expect(addRscCssResourceCrossOrigin(`props = { 'data-rsc-css-href' : cssHref }`)).toBe(
      `props = { crossOrigin: "",\n        'data-rsc-css-href' : cssHref }`,
    );
  });

  it("fails loudly when plugin-rsc changes the resource module shape", () => {
    expect(() =>
      addRscCssResourceCrossOrigin("export default function Resources() {}"),
    ).toThrowError(/changed its CSS resource module shape/);
  });
});

describe("inline CSS stylesheet deduplication", () => {
  it("matches equivalent absolute and root-relative hrefs", () => {
    vi.stubGlobal("window", { location: { href: "https://example.com/docs/page" } });
    expect(
      inlineStyleCoversStylesheetHref(
        "/assets/other.css https://example.com/assets/app.css",
        "/assets/app.css",
      ),
    ).toBe(true);
  });

  it("removes React-managed links covered by inline CSS", () => {
    const style = fakeElement({ "data-href": "/assets/app.css" });
    const link = fakeElement({
      rel: "stylesheet",
      href: "https://example.com/assets/app.css",
      "data-precedence": "default",
    });
    vi.stubGlobal("window", { location: { href: "https://example.com/" } });
    vi.stubGlobal("document", {
      head: {
        querySelectorAll: (selector: string) => (selector.startsWith("style") ? [style] : [link]),
      },
    });

    removeStylesheetLinksCoveredByInlineCss();
    expect(link.remove).toHaveBeenCalledOnce();
  });

  it("keeps the managed global owner when duplicate links are present", () => {
    const unmanaged = fakeElement({ rel: "stylesheet", href: "/app-global-css-abc.css" });
    const managed = fakeElement({
      rel: "stylesheet",
      href: "https://example.com/app-global-css-abc.css",
      "data-precedence": "default",
    });
    vi.stubGlobal("window", { location: { href: "https://example.com/" } });
    vi.stubGlobal("document", {
      head: { querySelectorAll: () => [unmanaged, managed] },
    });

    dedupeGlobalCssOwnerStylesheetLinks();
    expect(unmanaged.remove).toHaveBeenCalledOnce();
    expect(managed.remove).not.toHaveBeenCalled();
  });

  it("does nothing when imported outside a browser", () => {
    expect(() => installGlobalCssOwnerStylesheetDedupe()).not.toThrow();
  });
});
