import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  performOnDemandRevalidate,
  resolveNodeRevalidateOrigin,
} from "../packages/vinext/src/server/pages-revalidate.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("performOnDemandRevalidate", () => {
  it("sends the revalidation request to the trusted application origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await performOnDemandRevalidate("http://127.0.0.1:8787", "/products?id=1");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [target, init] = fetchMock.mock.calls[0];
    expect(String(target)).toBe("http://127.0.0.1:8787/products?id=1");
    expect(init).toMatchObject({ method: "HEAD", redirect: "manual" });
    expect(init.headers["x-prerender-revalidate"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["//attacker.example/leak", "/\\attacker.example/leak", "/\t/attacker.example/leak"])(
    "rejects authority-like paths before sending the secret: %j",
    async (urlPath) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(performOnDemandRevalidate("https://app.example", urlPath)).rejects.toThrow(
        "Invalid urlPath provided to revalidate()",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("does not follow redirects with the revalidation secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.example/leak" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(performOnDemandRevalidate("https://app.example", "/redirect")).rejects.toThrow(
      "Failed to revalidate /redirect: 302",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it.each([
    ["/post", "/post/"],
    ["/post/", "/post"],
  ])("follows a same-origin canonical redirect from %s to %s", async (urlPath, location) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 308, headers: { location } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await performOnDemandRevalidate("https://app.example", urlPath);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`https://app.example${urlPath}`);
    expect(String(fetchMock.mock.calls[1][0])).toBe(`https://app.example${location}`);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ redirect: "manual" });
  });

  it("stops after a bounded number of same-origin redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 308,
        headers: { location: "/redirect" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(performOnDemandRevalidate("https://app.example", "/redirect")).rejects.toThrow(
      "Failed to revalidate /redirect: 308",
    );
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe("resolveNodeRevalidateOrigin", () => {
  it("uses the server-side socket instead of the request Host header", () => {
    const request = {
      headers: { host: "attacker.example" },
      socket: { localAddress: "127.0.0.1", localPort: 3000 },
    };

    expect(resolveNodeRevalidateOrigin(request)).toBe("http://127.0.0.1:3000");
  });

  it("formats IPv6 socket addresses", () => {
    const request = {
      headers: { host: "attacker.example" },
      socket: { localAddress: "::1", localPort: 3000 },
    };

    expect(resolveNodeRevalidateOrigin(request)).toBe("http://[::1]:3000");
  });

  it("uses TLS when the local server socket is encrypted", () => {
    const request = {
      socket: { encrypted: true, localAddress: "127.0.0.1", localPort: 3443 },
    };

    expect(resolveNodeRevalidateOrigin(request)).toBe("https://127.0.0.1:3443");
  });
});
