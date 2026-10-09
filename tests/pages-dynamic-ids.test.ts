import { describe, expect, it } from "vite-plus/test";
import { buildPagesNextDataScript } from "../packages/vinext/src/server/pages-page-response.js";
import {
  DEFERRED_PAGES_DYNAMIC_IDS,
  fillPagesDynamicIds,
} from "../packages/vinext/src/server/pages-dynamic-ids.js";

function nextDataScript(pageProps: Record<string, unknown>) {
  return buildPagesNextDataScript({
    buildId: "build",
    i18n: { locale: undefined, locales: undefined, defaultLocale: undefined, domainLocales: [] },
    pageProps,
    params: {},
    routePattern: "/",
    safeJsonStringify: (value) => JSON.stringify(value),
    vinext: { hasMiddleware: false },
    dynamicIds: DEFERRED_PAGES_DYNAMIC_IDS,
  });
}

function parseNextData(html: string): Record<string, unknown> {
  return JSON.parse(html.slice(html.indexOf(">") + 1, html.lastIndexOf("</script>")));
}

describe("deferred __NEXT_DATA__.dynamicIds", () => {
  it("fills in the rendered module ids", () => {
    const html = fillPagesDynamicIds(nextDataScript({}), ["components/a.tsx"], JSON.stringify);
    expect(parseNextData(html).dynamicIds).toEqual(["components/a.tsx"]);
  });

  it("drops the property when no dynamic() rendered, like Next.js", () => {
    const html = fillPagesDynamicIds(nextDataScript({}), undefined, JSON.stringify);
    expect(parseNextData(html)).not.toHaveProperty("dynamicIds");
  });

  it("only fills the placeholder inside the __NEXT_DATA__ script", () => {
    // e.g. a JSON-LD <Head> script built from request data.
    const headScript = `<script type="application/ld+json">{"a":1,"dynamicIds":"${DEFERRED_PAGES_DYNAMIC_IDS}"}</script>`;
    expect(fillPagesDynamicIds(headScript, ["components/a.tsx"], JSON.stringify)).toBe(headScript);

    const html = fillPagesDynamicIds(
      headScript + nextDataScript({}),
      ["components/a.tsx"],
      JSON.stringify,
    );
    expect(html.startsWith(headScript)).toBe(true);
    expect(parseNextData(html.slice(headScript.length)).dynamicIds).toEqual(["components/a.tsx"]);
  });

  it("leaves user data that looks like the placeholder alone", () => {
    // Not the first key, so it serializes as `,"dynamicIds":"…"` like the
    // real placeholder property.
    const pageProps = { other: 1, dynamicIds: DEFERRED_PAGES_DYNAMIC_IDS };
    const html = fillPagesDynamicIds(
      nextDataScript(pageProps),
      ["components/a.tsx"],
      JSON.stringify,
    );
    const nextData = parseNextData(html) as { props: { pageProps: unknown }; dynamicIds: unknown };
    expect(nextData.props.pageProps).toEqual(pageProps);
    expect(nextData.dynamicIds).toEqual(["components/a.tsx"]);
  });
});
