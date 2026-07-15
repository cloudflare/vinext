import { describe, expect, it } from "vite-plus/test";
import {
  createRscTransportAssetPathname,
  resolveRscTransportRequest,
  resolveRscTransportRoutePathname,
  VINEXT_STATIC_RSC_TRANSPORT_PREFIX,
  VINEXT_WORKER_RSC_TRANSPORT_PREFIX,
} from "../packages/vinext/src/server/app-rsc-transport.js";

describe("App Router RSC transport encoding", () => {
  // Routes chosen to collide under structured transport filenames: `/__root`
  // aliased the `/` sentinel, `/docs/__index` aliased the `/docs/` sentinel,
  // and `/foo.rsc` / `/a%2Fb` stress suffix stripping and percent-encoding.
  const routes = ["/", "/__root", "/docs/", "/docs/__index", "/foo.rsc", "/a%2Fb"];

  it("round-trips visible routes through both transport prefixes", () => {
    for (const route of routes) {
      const assetPathname = createRscTransportAssetPathname(route);
      expect(
        resolveRscTransportRoutePathname(`${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}${assetPathname}`),
      ).toBe(route);
      expect(
        resolveRscTransportRoutePathname(`${VINEXT_WORKER_RSC_TRANSPORT_PREFIX}${assetPathname}`),
      ).toBe(route);
    }
  });

  it("maps distinct routes to distinct transport assets", () => {
    const assetPathnames = routes.map(createRscTransportAssetPathname);
    expect(new Set(assetPathnames).size).toBe(routes.length);
  });

  it("encodes the visible pathname as a stable opaque token", () => {
    // Hand-derived: base64url of the raw pathname bytes.
    expect(createRscTransportAssetPathname("/")).toBe("/Lw.rsc");
    expect(createRscTransportAssetPathname("/about")).toBe("/L2Fib3V0.rsc");
    expect(createRscTransportAssetPathname("/docs/")).toBe("/L2RvY3Mv.rsc");
  });

  it("rejects non-canonical base64url spellings of a canonical token", () => {
    // Forgiving base64 decodes Lx/Ly/Lz and padded Lw== to the same byte as
    // the canonical Lw ("/"); only the canonical spelling may resolve.
    expect(resolveRscTransportRoutePathname(`${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/Lw.rsc`)).toBe(
      "/",
    );
    for (const alias of ["Lx", "Ly", "Lz", "Lw=="]) {
      expect(
        resolveRscTransportRoutePathname(`${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/${alias}.rsc`),
      ).toBe(null);
    }
  });

  it("rejects tokens whose bytes are not valid UTF-8", () => {
    // "L_8" is the canonical base64url of 0x2F 0xFF — rooted but invalid UTF-8.
    expect(resolveRscTransportRoutePathname(`${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/L_8.rsc`)).toBe(
      null,
    );
  });

  it("rejects transport paths that do not decode to a rooted pathname", () => {
    // "YWJvdXQ" decodes to "about" — valid base64url, not a rooted pathname.
    expect(
      resolveRscTransportRoutePathname(`${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/YWJvdXQ.rsc`),
    ).toBe(null);
    expect(
      resolveRscTransportRoutePathname(`${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/not+base64!.rsc`),
    ).toBe(null);
    expect(resolveRscTransportRoutePathname(`${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/a/b.rsc`)).toBe(
      null,
    );
    expect(resolveRscTransportRoutePathname(`${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/.rsc`)).toBe(
      null,
    );
    expect(resolveRscTransportRoutePathname(`${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/Lw`)).toBe(null);
    expect(resolveRscTransportRoutePathname("/other/Lw.rsc")).toBe(null);
  });

  it("rejects decoded tokens that contain URL query or fragment syntax", () => {
    // Hand-crafted canonical base64url tokens for "/about?x=1" and
    // "/about#frag". The public encoder rejects these because they are not
    // pathnames; the decoder has to reject them too.
    const withQuery = `${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/L2Fib3V0P3g9MQ.rsc`;
    const withFragment = `${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/L2Fib3V0I2ZyYWc.rsc`;

    expect(resolveRscTransportRoutePathname(withQuery)).toBe(null);
    expect(resolveRscTransportRoutePathname(withFragment)).toBe(null);

    const request = new Request(`https://example.test${withQuery}?_rsc=fresh`, {
      headers: { RSC: "1" },
    });
    expect(resolveRscTransportRequest(request)).toBe(request);
  });

  it("rejects decoded tokens the URL implementation would rewrite", () => {
    // Hand-crafted canonical base64url tokens for pathnames that a URL
    // pathname assignment would silently rewrite, breaking the bijective
    // route-token invariant: "/foo\bar" (backslash → "/foo/bar"),
    // "/\evil.com" (→ "//evil.com"), "/foo\nbar" (newline stripped), and
    // "/foo/../bar" (dot segments resolved to "/bar").
    for (const token of ["L2Zvb1xiYXI", "L1xldmlsLmNvbQ", "L2ZvbwpiYXI", "L2Zvby8uLi9iYXI"]) {
      const transportPathname = `${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/${token}.rsc`;
      expect(resolveRscTransportRoutePathname(transportPathname)).toBe(null);

      const request = new Request(`https://example.test${transportPathname}`, {
        headers: { RSC: "1" },
      });
      expect(resolveRscTransportRequest(request)).toBe(request);
    }
  });
});
