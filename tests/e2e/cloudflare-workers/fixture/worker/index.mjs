import handler from "vinext/server/fetch-handler";

const CSP = "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (["/api/request-cf", "/api/request-cf-force-static"].includes(url.pathname)) {
      const requestWithCf = new Request(request, {
        cf: {
          ...request.cf,
          cacheKey: url.searchParams.get("marker") ?? "preserved",
        },
      });
      return handler.fetch(requestWithCf, env, ctx);
    }
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("content-security-policy", CSP);
    const response = await handler.fetch(
      new Request(request, { headers: requestHeaders }),
      env,
      ctx,
    );
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("content-security-policy", CSP);
    return new Response(response.body, {
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
    });
  },
};
