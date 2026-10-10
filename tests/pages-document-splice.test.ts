import { describe, expect, it } from "vite-plus/test";
import {
  spliceDocumentHeadClose,
  spliceDocumentHeadOpen,
  spliceDocumentScripts,
  splitDocumentAtMain,
} from "../packages/vinext/src/server/pages-document-splice.js";

const token = "token";
// Raw script text in a Document can carry any of these verbatim.
const forged =
  '<script>"<head> data-vinext-head-open="other"> <template data-vinext-head-close="other"></template>' +
  '<!-- __NEXT_MAIN__ --><!--__NEXT_MAIN__:other--><!--__NEXT_SCRIPTS__:other--></head></body>"</script>';
const documentHtml =
  `<html>${forged}<head lang="en" data-vinext-head-open="token"><title>t</title>` +
  '<template data-vinext-head-close="token"></template></head>' +
  `<body>${forged}<div id="__next"><!--__NEXT_MAIN__:token--></div>` +
  "<span><!--__NEXT_SCRIPTS__:token--></span></body></html>";

describe("Pages Document splicing", () => {
  it("splices only at this render's markers, never at forged ones", () => {
    let html = spliceDocumentHeadOpen(documentHtml, token, "<meta open>");
    html = spliceDocumentHeadClose(html, token, "<link close>");
    html = spliceDocumentScripts(html, token, "<script scripts></script>");

    expect(splitDocumentAtMain(html, token)).toEqual({
      prefix:
        `<html>${forged}<head lang="en"><meta open><title>t</title><link close></head>` +
        `<body>${forged}<div id="__next">`,
      suffix: "</div><span><script scripts></script></span></body></html>",
    });
  });

  it("inserts after the opening Head tag when attributes follow its marker", () => {
    const html =
      '<html><head data-vinext-head-open="token" lang="en"><title>t</title></head></html>';
    expect(spliceDocumentHeadOpen(html, token, "<meta open>")).toBe(
      '<html><head lang="en"><meta open><title>t</title></head></html>',
    );
  });

  it("inserts $ replacement patterns verbatim", () => {
    const insertion = "$`$'$&$$";
    let html = spliceDocumentHeadOpen(documentHtml, token, insertion);
    html = spliceDocumentHeadClose(html, token, insertion);
    html = spliceDocumentScripts(html, token, insertion);

    expect(html.split(insertion)).toHaveLength(4);
  });

  it("inserts nothing for a Document without Head or NextScript", () => {
    const html = `<html>${forged}<body>${forged}</body></html>`;
    expect(spliceDocumentHeadOpen(html, token, "x")).toBe(html);
    expect(spliceDocumentHeadClose(html, token, "x")).toBe(html);
    expect(spliceDocumentScripts(html, token, "x")).toBe(html);
  });

  it("puts the body after a Document without Main, like Next.js", () => {
    const html = `<html>${forged}<body>${forged}</body></html>`;
    expect(splitDocumentAtMain(html, token)).toEqual({ prefix: html, suffix: "" });
  });
});
