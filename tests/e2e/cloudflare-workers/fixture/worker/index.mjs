import handler from "vinext/server/app-router-entry";

const CSP = "script-src 'nonce-vinext-test-nonce' 'strict-dynamic';";

export default {
  async fetch(request, env, ctx) {
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
