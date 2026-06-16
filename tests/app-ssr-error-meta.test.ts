import { describe, expect, it } from "vite-plus/test";
import {
  createSsrErrorMetaRenderer,
  renderRedirectRefreshMetaTag,
  renderSsrErrorMetaTags,
} from "../packages/vinext/src/server/app-ssr-error-meta.js";

function digestError(digest: string): Error & { digest: string } {
  return Object.assign(new Error(digest), { digest });
}

describe("App SSR error meta tags", () => {
  it("renders noindex meta tags for streamed notFound and HTTP access fallback errors", () => {
    expect(renderSsrErrorMetaTags([digestError("NEXT_NOT_FOUND")])).toBe(
      '<meta name="robots" content="noindex"/>',
    );

    expect(renderSsrErrorMetaTags([digestError("NEXT_HTTP_ERROR_FALLBACK;403")])).toBe(
      '<meta name="robots" content="noindex"/>',
    );
  });

  it("renders development next-error metadata for streamed notFound errors", () => {
    expect(
      renderSsrErrorMetaTags([digestError("NEXT_NOT_FOUND")], { nodeEnv: "development" }),
    ).toBe(
      '<meta name="robots" content="noindex"/>' + '<meta name="next-error" content="not-found"/>',
    );
  });

  it("renders refresh meta tags for streamed temporary and permanent redirects", () => {
    expect(renderSsrErrorMetaTags([digestError("NEXT_REDIRECT;replace;/target;307")])).toBe(
      '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/target"/>',
    );

    expect(renderSsrErrorMetaTags([digestError("NEXT_REDIRECT;replace;/target;308")])).toBe(
      '<meta id="__next-page-redirect" http-equiv="refresh" content="0;url=/target"/>',
    );
  });

  it("prefixes app-internal redirect meta URLs with the configured basePath", () => {
    expect(
      renderSsrErrorMetaTags([digestError("NEXT_REDIRECT;replace;/target?ok=1#done;307")], {
        basePath: "/docs",
      }),
    ).toBe(
      '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/docs/target?ok=1#done"/>',
    );

    expect(
      renderSsrErrorMetaTags([digestError("NEXT_REDIRECT;replace;https%3A%2F%2Fexample.com;307")], {
        basePath: "/docs",
      }),
    ).toBe(
      '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=https://example.com"/>',
    );

    expect(
      renderSsrErrorMetaTags([digestError("NEXT_REDIRECT;replace;/docs%3Ffrom%3Dcheckout;307")], {
        basePath: "/docs",
      }),
    ).toBe(
      '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/docs?from=checkout"/>',
    );

    expect(
      renderSsrErrorMetaTags([digestError("NEXT_REDIRECT;replace;/docs%23top;307")], {
        basePath: "/docs",
      }),
    ).toBe('<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/docs#top"/>');
  });

  it("escapes redirect meta URLs before inserting them into HTML", () => {
    expect(
      renderSsrErrorMetaTags([
        digestError("NEXT_REDIRECT;replace;/target%3Fnext%3D%26%22%3Cscript%3E;307"),
      ]),
    ).toBe(
      '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/target?next=&amp;&quot;&lt;script&gt;"/>',
    );
  });

  it("flushes each captured SSR error meta tag once", () => {
    const renderer = createSsrErrorMetaRenderer({ nodeEnv: "production" });

    renderer.capture(digestError("NEXT_NOT_FOUND"));
    expect(renderer.flush()).toBe('<meta name="robots" content="noindex"/>');
    expect(renderer.flush()).toBe("");

    renderer.capture(digestError("NEXT_REDIRECT;replace;/target;307"));
    expect(renderer.flush()).toBe(
      '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/target"/>',
    );
    expect(renderer.flush()).toBe("");
  });

  describe("renderRedirectRefreshMetaTag (resolved-URL path, #1977)", () => {
    // Unlike the digest path, this entry point takes an already-resolved URL and
    // must NOT decode or split it — the metadata document-redirect path holds the
    // final URL and only needs HTML-attribute escaping.
    it("emits a percent-encoded URL verbatim without double-decoding", () => {
      expect(renderRedirectRefreshMetaTag("/search?q=50%25off", 307)).toBe(
        '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/search?q=50%25off"/>',
      );
    });

    it("preserves a semicolon in the URL without truncating", () => {
      expect(renderRedirectRefreshMetaTag("/a?b=1;c=2", 307)).toBe(
        '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/a?b=1;c=2"/>',
      );
    });

    it("uses a 0s delay for permanent (308) redirects", () => {
      expect(renderRedirectRefreshMetaTag("/perm", 308)).toBe(
        '<meta id="__next-page-redirect" http-equiv="refresh" content="0;url=/perm"/>',
      );
    });

    it("HTML-escapes the URL for attribute context", () => {
      expect(renderRedirectRefreshMetaTag('/x?a=1&b=2&q="<x>', 307)).toBe(
        '<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/x?a=1&amp;b=2&amp;q=&quot;&lt;x&gt;"/>',
      );
    });
  });
});
