import { describe, expect, it } from "vite-plus/test";
import {
  createAppPageNavigationMetadataScript,
  prepareAppPageHtmlForCache,
  rewriteAppPageHtmlNavigation,
  stripAppPageNavigationMetadata,
} from "../packages/vinext/src/server/app-page-cache-navigation.js";

describe("App page cached navigation metadata", () => {
  it("marks request-specific metadata and preserves a nonce on fresh responses", () => {
    const script = createAppPageNavigationMetadataScript(
      {
        pathname: "/invite/alice-secret-token",
        searchParams: [["preview", "alice-query-secret"]],
      },
      "nonce-value",
    );

    expect(script).toContain('<script data-vinext-navigation-metadata nonce="nonce-value">');
    expect(script).toContain('"pathname":"/invite/alice-secret-token"');
    expect(script).toContain('"searchParams":[["preview","alice-query-secret"]]');
  });

  it("removes every marked navigation script before HTML persistence", () => {
    const first = createAppPageNavigationMetadataScript({
      pathname: "/invite/alice-secret-token",
      searchParams: [["preview", "alice-query-secret"]],
    });
    const second = createAppPageNavigationMetadataScript({
      pathname: "/invite/bob-secret-token",
      searchParams: [],
    });
    const cached = stripAppPageNavigationMetadata(
      `<html><head><script>keep()</script>${first}${second}</head><body>safe</body></html>`,
    );

    expect(cached).toBe(
      "<html><head><script>keep()</script><!--vinext-navigation-metadata--></head><body>safe</body></html>",
    );
    expect(cached).not.toContain("alice-secret-token");
    expect(cached).not.toContain("alice-query-secret");
    expect(cached).not.toContain("bob-secret-token");
  });

  it("fails closed for legacy or malformed request-specific metadata", () => {
    expect(prepareAppPageHtmlForCache("<html><head></head></html>")).toBe(
      "<html><head></head></html>",
    );
    expect(
      prepareAppPageHtmlForCache(
        '<script>Object.assign(runtime.bootstrap.rsc,{params:{},nav:{"pathname":"/secret"}})</script>',
      ),
    ).toBeNull();
    expect(
      prepareAppPageHtmlForCache(
        '<script>Object.assign(runtime.bootstrap.rsc,{params:{}});Object.assign(runtime.bootstrap.rsc,{nav:{"pathname":"/secret"}})</script>',
      ),
    ).toBeNull();
    expect(
      prepareAppPageHtmlForCache(
        "<html><head><script data-vinext-navigation-metadata>unterminated",
      ),
    ).toBeNull();
  });

  it("injects only the current request navigation before the closing head", () => {
    const stale = createAppPageNavigationMetadataScript({
      pathname: "/invite/alice-secret-token",
      searchParams: [["preview", "alice-query-secret"]],
    });
    const html = rewriteAppPageHtmlNavigation(
      `<html><head><script>params()</script>${stale}</head><body>cached</body></html>`,
      {
        pathname: "/invite/bob-public-token",
        searchParams: [["preview", "bob-query-value"]],
      },
    );

    expect(html).toContain("<script>params()</script>");
    expect(html).toContain('"pathname":"/invite/bob-public-token"');
    expect(html).toContain('"searchParams":[["preview","bob-query-value"]]');
    expect(html).not.toContain("alice-secret-token");
    expect(html).not.toContain("alice-query-secret");
    expect(html.indexOf("data-vinext-navigation-metadata")).toBeLessThan(html.indexOf("</head>"));
  });

  it("does not modify legacy HTML without a request-neutral marker", () => {
    const html = rewriteAppPageHtmlNavigation("<main>legacy cached</main>", {
      pathname: "/current",
      searchParams: [],
    });

    expect(html).toBe("<main>legacy cached</main>");
  });
});
