import handler from "vinext/server/fetch-handler";

const CSP = "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';";

export default {
  async fetch(request, env, ctx) {
    // Nonced responses intentionally skip ISR cache reads, so scope the nonce
    // to the preload route that exercises it.
    const usesNonce = new URL(request.url).pathname === "/dynamic-preload";
    const requestHeaders = new Headers(request.headers);
    if (usesNonce) requestHeaders.set("content-security-policy", CSP);
    const response = await handler.fetch(
      new Request(request, { headers: requestHeaders }),
      env,
      ctx,
    );
    const responseHeaders = new Headers(response.headers);
    if (usesNonce) responseHeaders.set("content-security-policy", CSP);
    return new Response(response.body, {
      headers: responseHeaders,
      status: response.status,
      statusText: response.statusText,
    });
  },
};
