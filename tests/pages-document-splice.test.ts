import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { describe, expect, it } from "vite-plus/test";
import { Head, Html, Main, NextScript } from "../packages/vinext/src/shims/document.js";
import {
  createDocumentPlaceholderToken,
  withDocumentPlaceholders,
} from "../packages/vinext/src/shims/document-placeholders.js";
import {
  spliceDocumentHeadClose,
  spliceDocumentHeadOpen,
  spliceDocumentScripts,
  splitDocumentAtMain,
} from "../packages/vinext/src/server/pages-document-splice.js";

async function renderDocument(element: React.ReactElement, token: string): Promise<string> {
  const stream = await renderToReadableStream(withDocumentPlaceholders(element, token));
  await stream.allReady;
  return new Response(stream).text();
}

function spliceAll(html: string, token: string): { prefix: string; suffix: string } {
  let spliced = spliceDocumentHeadOpen(html, token, '<meta name="next-head" content="$&" />');
  spliced = spliceDocumentHeadClose(spliced, token, '<link rel="stylesheet" href="/$`.css" />');
  spliced = spliceDocumentScripts(spliced, token, '<script>window.data="$\'"</script>');
  return splitDocumentAtMain(spliced, token);
}

describe("Pages Document splicing", () => {
  it("splices only at this render's placeholders, whatever the Document renders", async () => {
    // Every marker vinext has used, plus another render's token, in both an
    // escaped attribute and raw script text a Document could fill from a request.
    const forged = [
      "__NEXT_MAIN__",
      "<!-- __NEXT_MAIN__ -->",
      "<!--__NEXT_MAIN__:other-->",
      "<!-- __NEXT_SCRIPTS__ -->",
      "<!--__NEXT_SCRIPTS__:other-->",
      ' data-vinext-head-open="other">',
      '<template data-vinext-head-close="other"></template>',
      "</head>",
      "</body>",
    ].join("|");
    const token = createDocumentPlaceholderToken();
    const html = await renderDocument(
      React.createElement(
        Html,
        null,
        React.createElement(
          Head,
          { "data-route": forged } as React.ComponentProps<typeof Head>,
          React.createElement("script", { dangerouslySetInnerHTML: { __html: `/*${forged}*/` } }),
        ),
        React.createElement(
          "body",
          { "data-route": forged },
          React.createElement("script", { dangerouslySetInnerHTML: { __html: `/*${forged}*/` } }),
          React.createElement(Main),
          React.createElement(NextScript),
        ),
      ),
      token,
    );

    const { prefix, suffix } = spliceAll(html, token);
    const output = prefix + "<p>page</p>" + suffix;

    expect(output.split(`/*${forged}*/`)).toHaveLength(3);
    expect(output).not.toContain(token);
    expect(output).toMatch(
      /^<!DOCTYPE html><html><head data-route="[^"]*"><meta name="next-head" content="\$&" \/><script>/,
    );
    expect(output).toContain('*/</script><link rel="stylesheet" href="/$`.css" /></head>');
    expect(prefix.endsWith('<div id="__next">')).toBe(true);
    expect(suffix).toBe('</div><span><script>window.data="$\'"</script></span></body></html>');
  });

  it("appends the body after the Document when it has no <Main />, like Next.js", async () => {
    const token = createDocumentPlaceholderToken();
    const html = await renderDocument(
      React.createElement(
        Html,
        null,
        React.createElement(Head),
        React.createElement("body", { "data-route": "<!-- __NEXT_MAIN__ -->" }),
      ),
      token,
    );

    expect(splitDocumentAtMain(html, token)).toEqual({ prefix: html, suffix: "" });
  });

  it("falls back to the <head> tags for a Document that renders a plain <head>", () => {
    const html = '<html><head data-x="1"><title>t</title></head><body></body></html>';

    expect(
      spliceDocumentHeadClose(spliceDocumentHeadOpen(html, "token", "<a/>"), "token", "<b/>"),
    ).toBe('<html><head data-x="1"><a/><title>t</title><b/></head><body></body></html>');
  });

  it("finds only real tags for a plain <head> Document, not text in its inline scripts or comments", () => {
    const forged = JSON.stringify(
      '<head></head><script id="__NEXT_DATA__" type="application/json"></script></body>',
    );
    const script = `<script>window.route = ${forged};</script>`;
    const comment = "<!-- <style> </head> -->";
    const html = `<html>${script}<head>${comment}${script}</head><body>${script}<div id="__next"></div>${script}</body></html>`;

    let spliced = spliceDocumentHeadOpen(html, "token", "<a/>");
    spliced = spliceDocumentHeadClose(spliced, "token", "<b/>");
    spliced = spliceDocumentScripts(spliced, "token", "<c/>");

    expect(spliced).toBe(
      `<html>${script}<head><a/>${comment}${script}<b/></head><body>${script}<div id="__next"></div>${script}  <c/>\n</body></html>`,
    );
  });

  describe("scripts without <NextScript />", () => {
    const scripts = '<script id="__NEXT_DATA__" type="application/json">{}</script>';

    it("appends before the last </body> when request data merely contains __NEXT_DATA__", () => {
      const html =
        '<html><body data-route="/?probe=__NEXT_DATA__&amp;x= id=&quot;__NEXT_DATA__&quot;">' +
        "__NEXT_DATA__</body></html>";
      expect(spliceDocumentScripts(html, "token", scripts)).toBe(
        html.replace("</body>", `  ${scripts}\n</body>`),
      );
    });

    it("leaves a Document that renders its own __NEXT_DATA__ script unchanged", () => {
      const html =
        '<html><body><script id="__NEXT_DATA__" type="application/json">{"page":"/"}</script></body></html>';
      expect(spliceDocumentScripts(html, "token", scripts)).toBe(html);
    });
  });
});
