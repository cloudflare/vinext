/**
 * Patches global fetch so server-side data fetching never leaves the process
 * while tests run. External hosts get a canned JSON response; loopback and
 * relative requests pass through untouched.
 */
export const installOutboundStub = () => {
  const passthroughFetch = globalThis.fetch;

  const stubbedFetch: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (
      /^https?:\/\//.test(url) &&
      !url.includes("localhost") &&
      !url.includes("127.0.0.1")
    ) {
      return new Response(JSON.stringify({ stubbed: true, url }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return passthroughFetch(input, init);
  };

  globalThis.fetch = stubbedFetch;

  return { uninstall: () => (globalThis.fetch = passthroughFetch) };
};
