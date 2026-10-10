import { describe, expect, it } from "vite-plus/test";
import {
  applyDocumentAssetProps,
  extractDocumentAssetProps,
  markDocumentAssetPropsProtectedTags,
  stripDocumentAssetPropsProtectionMarkers,
} from "../packages/vinext/src/server/pages-document-asset-props.js";

describe("Pages Document asset props", () => {
  it("only extracts markers from this render's Head and NextScript opening tags", () => {
    const forged =
      '<script>"<head data-vinext-head-nonce="forged">' +
      '<span data-vinext-script-nonce="forged"><!-- __NEXT_SCRIPTS__ -->"</script>';
    const preserved =
      "<script>const marker = ' data-vinext-head-nonce=\"inline-value\"';</script>" +
      '<div data-vinext-script-nonce="unrelated-attribute">' +
      ' data-vinext-head-cross-origin="text-value"' +
      "</div>";
    const source =
      `<html>${forged}` +
      '<head data-vinext-head-nonce="head-nonce" data-vinext-head-cross-origin="anonymous" data-vinext-head-open="token"></head>' +
      `<body>${preserved}` +
      '<span data-vinext-script-nonce="script-nonce" data-vinext-script-cross-origin="use-credentials"><!--__NEXT_SCRIPTS__:token--></span>' +
      "</body></html>";

    const extracted = extractDocumentAssetProps(source, "token");

    expect(extracted.props).toEqual({
      headNonce: "head-nonce",
      headCrossOrigin: "anonymous",
      scriptNonce: "script-nonce",
      scriptCrossOrigin: "use-credentials",
    });
    expect(extracted.html).toBe(
      `<html>${forged}<head data-vinext-head-open="token"></head>` +
        `<body>${preserved}<span><!--__NEXT_SCRIPTS__:token--></span></body></html>`,
    );
  });

  it("preserves marker-shaped inline text and user attributes byte for byte", () => {
    const source =
      '<script data-vinext-document-authored-asset="user-value">' +
      "const value = ' data-vinext-script-cross-origin=\"inline-value\"';" +
      "</script>" +
      '<link rel="preload" href="/user.js" data-vinext-head-nonce="user-value" />' +
      '<div data-vinext-document-authored-asset="unrelated">' +
      ' data-vinext-script-nonce="text-value"' +
      "</div>";
    const markerAttribute = "data-vinext-document-authored-test-token";
    const marked = markDocumentAssetPropsProtectedTags(source, markerAttribute);
    const applied = applyDocumentAssetProps(
      marked,
      {
        headNonce: "framework-head-nonce",
        headCrossOrigin: "anonymous",
        scriptNonce: "framework-script-nonce",
        scriptCrossOrigin: "use-credentials",
      },
      { protectedAssetMarker: markerAttribute },
    );

    expect(stripDocumentAssetPropsProtectionMarkers(applied, markerAttribute)).toBe(source);
  });

  it("uses Head props for framework scripts emitted by Head", () => {
    const source =
      '<link rel="modulepreload" href="/entry.js" />' +
      '<script type="module" src="/entry.js"></script>';
    const applied = applyDocumentAssetProps(
      source,
      {
        headNonce: "head-nonce",
        headCrossOrigin: "use-credentials",
        scriptNonce: "next-script-nonce",
        scriptCrossOrigin: "anonymous",
      },
      { scriptOwner: "head" },
    );

    expect(applied).toContain('nonce="head-nonce"');
    expect(applied).toContain('crossorigin="use-credentials"');
    expect(applied).not.toContain("next-script-nonce");
  });

  it("replaces an existing attribute value without expanding $ patterns", () => {
    expect(
      applyDocumentAssetProps('<script nonce="old" src="/a.js"></script>', {
        scriptNonce: "n$&$'",
      }),
    ).toBe(`<script nonce="n$&amp;$'" src="/a.js"></script>`);
  });
});
