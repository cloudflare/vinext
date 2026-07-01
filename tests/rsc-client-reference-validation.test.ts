import { describe, expect, it } from "vite-plus/test";
import { isVinextRscClientReferenceValidation } from "../packages/vinext/src/plugins/rsc-client-reference-validation.js";

function validationId(referenceId: string, type = "client"): string {
  return `\0virtual:vite-rsc/reference-validation?type=${type}&id=${encodeURIComponent(
    referenceId,
  )}&lang.js`;
}

function clientInServerPackageProxy(moduleId: string): string {
  return `/@id/\0virtual:vite-rsc/client-in-server-package-proxy/${encodeURIComponent(moduleId)}`;
}

describe("rscClientReferenceValidationPlugin", () => {
  it("accepts decoded validation ids for vinext's emitted client shims", () => {
    const referenceId = clientInServerPackageProxy(
      "/private/tmp/app/node_modules/.pnpm/vinext@file+pkg/node_modules/vinext/dist/shims/app-router-scroll.js",
    );

    expect(isVinextRscClientReferenceValidation(validationId(referenceId))).toBe(true);
  });

  it("accepts plugin-rsc's CSS dedupe virtual reference", () => {
    expect(
      isVinextRscClientReferenceValidation(
        validationId("/@id/\0virtual:vite-rsc/remove-duplicate-server-css"),
      ),
    ).toBe(true);
  });

  it("accepts package-proxy validation ids for Next client shims vinext owns", () => {
    expect(
      isVinextRscClientReferenceValidation(
        validationId("/@id/\0virtual:vite-rsc/client-package-proxy/next/image"),
      ),
    ).toBe(true);
  });

  it("accepts non-pnpm node_modules installs", () => {
    const referenceId = clientInServerPackageProxy(
      "C:/tmp/app/node_modules/vinext/dist/shims/error-boundary.js",
    );

    expect(isVinextRscClientReferenceValidation(validationId(referenceId))).toBe(true);
  });

  it("rejects non-client and non-vinext validation ids", () => {
    const vinextReferenceId = clientInServerPackageProxy(
      "/private/tmp/app/node_modules/vinext/dist/shims/default-global-error.js",
    );
    const appReferenceId = clientInServerPackageProxy("/private/tmp/app/app/global-error.tsx");

    expect(isVinextRscClientReferenceValidation(validationId(vinextReferenceId, "server"))).toBe(
      false,
    );
    expect(
      isVinextRscClientReferenceValidation(
        validationId("/@id/\0virtual:vite-rsc/client-package-proxy/some-package/client"),
      ),
    ).toBe(false);
    expect(isVinextRscClientReferenceValidation(validationId(appReferenceId))).toBe(false);
  });
});
