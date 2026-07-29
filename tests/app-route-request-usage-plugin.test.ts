import { describe, expect, it } from "vite-plus/test";
import {
  analyzeAppRouteRequestUsage,
  transformAppRouteRequestUsage,
} from "../packages/vinext/src/plugins/app-route-request-usage.js";
import { APP_ROUTE_REQUEST_USAGE_EXPORT } from "../packages/vinext/src/server/app-route-handler-request-usage.js";

describe("app route request usage transform", () => {
  it("marks a directly referenced request and proves unused handlers safe", () => {
    const result = analyzeAppRouteRequestUsage(`
      export function GET(request) { return new Request(request) }
      export function POST(_request) { return new Response("ok") }
      export const PUT = () => new Response("ok")
    `);

    expect(result.metadata).toEqual({ GET: true, POST: false, PUT: false });
  });

  it("keeps direct tracked and Next-static member reads on precise runtime tracking", () => {
    const result = analyzeAppRouteRequestUsage(`
      export function GET(request) {
        return Response.json({
          method: request.method,
          optionalMethod: request?.method,
          pathname: request.nextUrl.pathname,
          tenant: request.headers.get("x-tenant"),
        })
      }
      export function POST({ headers }) { return Response.json({ tenant: headers.get("x") }) }
      export function PUT({ nextUrl: { pathname } }) { return new Response(pathname) }
      export function PATCH({ nextUrl }) { return new Response(nextUrl.pathname) }
    `);

    expect(result.metadata).toEqual({ GET: false, POST: false, PUT: false, PATCH: true });
  });

  it("fails closed for every raw request escape and unknown context", () => {
    const result = analyzeAppRouteRequestUsage(`
      export function GET(request) { return consume(request) }
      export function HEAD(request) { return request }
      export function POST(request) { const saved = request; return saved }
      export function PUT(request) { return [...request] }
      export function DELETE(request) { request.url = "https://example.com"; return new Response() }
      export function PATCH(request, _ctx, key) { return request[key] }
      export function OPTIONS(request) { return new Request(request.clone()) }
    `);

    expect(result.metadata).toEqual({
      GET: true,
      HEAD: true,
      POST: true,
      PUT: true,
      DELETE: true,
      PATCH: true,
      OPTIONS: true,
    });
  });

  it("fails closed for string-indexed arguments and valueOf raw-request recovery", () => {
    const result = analyzeAppRouteRequestUsage(`
      export function GET() { return new Request(arguments["0"]) }
      export function POST(request) { return new Request(request.valueOf()) }
      export function PUT(request) { return new Request(request["valueOf"]()) }
    `);

    expect(result.metadata).toEqual({ GET: true, POST: true, PUT: true });
  });

  it("fails closed when an unknown Request member can recover the raw request", () => {
    const result = analyzeAppRouteRequestUsage(`
      export function GET(request) {
        request.__defineGetter__("raw", function () { return this })
        const raw = request.raw
        return new Request(raw)
      }
      export function POST(request) {
        request.__proto__.raw = function () { return this }
        return new Request(request.raw())
      }
    `);

    expect(result.metadata).toEqual({ GET: true, POST: true });
  });

  it("applies the Request whitelist to parameter and body destructuring", () => {
    const result = analyzeAppRouteRequestUsage(`
      export function GET({ cf }) { return Response.json({ country: cf?.country }) }
      export function POST({ method }) { return new Response(method) }
      export function PUT(request) { const { cf } = request; return Response.json(cf) }
      export function PATCH(request) { const { method } = request; return new Response(method) }
    `);

    expect(result.metadata).toEqual({ GET: true, POST: false, PUT: true, PATCH: false });
  });

  it("fails closed when NextURL valueOf bypasses its tracking proxy", () => {
    const result = analyzeAppRouteRequestUsage(`
      export function GET(request) { return new Response(request.nextUrl.valueOf().search) }
      export function POST({ nextUrl: { valueOf } }) { return new Response(valueOf().search) }
      export function PUT(request) { return new Response(request.nextUrl["valueOf"]().search) }
    `);

    expect(result.metadata).toEqual({ GET: true, POST: true, PUT: true });
  });

  it("fails closed for unknown NextURL unwrapping hooks", () => {
    const result = analyzeAppRouteRequestUsage(`
      export function GET(request) { return new Response(request.nextUrl.toLocaleString()) }
      export function POST({ nextUrl: { toLocaleString } }) {
        return new Response(toLocaleString())
      }
      export function PUT(request) { return new Response(request.nextUrl[Symbol.toPrimitive]()) }
    `);

    expect(result.metadata).toEqual({ GET: true, POST: true, PUT: true });
  });

  it("fails closed for mutation through a request-derived NextURL", () => {
    const result = analyzeAppRouteRequestUsage(`
      export function GET(request) {
        request.nextUrl.href = "https://example.com/changed"
        return new Response(request.nextUrl.pathname)
      }
    `);

    expect(result.metadata).toEqual({ GET: true });
  });

  it("fails closed for default, rest, destructured, and arguments access", () => {
    const result = analyzeAppRouteRequestUsage(`
      export function GET(request = fallback) { return new Request(request) }
      export function POST(...args) { return new Request(args[0]) }
      export function PUT({ url }) { return new Response(url) }
      export function PATCH() { return new Request(arguments[0]) }
      export function DELETE(request) { return eval("new Request(request)") }
    `);

    expect(result.metadata).toEqual({
      GET: true,
      POST: true,
      PUT: true,
      PATCH: true,
      DELETE: true,
    });
  });

  it("scans later parameter initializers for request escapes", () => {
    const result = analyzeAppRouteRequestUsage(`
      export const GET = (request, _context, wrapped = new Request(request)) =>
        Response.json({ url: wrapped.url })
    `);

    expect(result.metadata).toEqual({ GET: true });
  });

  it("fails closed when a mutable exported handler binding is reassigned", () => {
    const result = analyzeAppRouteRequestUsage(`
      export let GET = () => new Response("static")
      GET = request => Response.json({ url: new Request(request).url })
      export function POST() { return new Response("static") }
      POST = request => Response.json({ url: new Request(request).url })
    `);

    expect(result.metadata).toEqual({ GET: true, POST: true });
  });

  it("fails closed for HOF, imported, and re-exported handlers", () => {
    const result = analyzeAppRouteRequestUsage(`
      import { handler } from "./handler";
      export const GET = wrap(handler);
      export { handler as POST };
      export { PUT } from "./put";
      export * from "./other-methods";
    `);

    expect(result.metadata).toEqual({ GET: true, POST: true, PUT: true });
  });

  it("analyzes local function bindings exported under HTTP method names", () => {
    const result = analyzeAppRouteRequestUsage(`
      function read(request) { return new Request(request) }
      const ignore = (_request) => new Response("ok")
      export { read as GET, ignore as POST }
    `);

    expect(result.metadata).toEqual({ GET: true, POST: false });
  });

  it("injects unmistakably internal frozen metadata", () => {
    const transformed = transformAppRouteRequestUsage(
      `export function GET() { return new Response("ok") }`,
      "/app/api/demo/route.js",
    );

    expect(transformed?.code).toContain(
      `export const ${APP_ROUTE_REQUEST_USAGE_EXPORT} = Object.freeze({"GET":false})`,
    );
  });

  it("does not transform an unrelated file merely named route", () => {
    expect(
      transformAppRouteRequestUsage(
        `export function buildRoute() { return "/demo" }`,
        "/src/route.js",
      ),
    ).toBeNull();
  });

  it("fails closed without aborting the transform for malformed route source", () => {
    expect(
      transformAppRouteRequestUsage(`export function GET(`, "/app/api/demo/route.js"),
    ).toBeNull();
  });

  it("rejects a user collision with the reserved export", () => {
    expect(() =>
      transformAppRouteRequestUsage(
        `export const ${APP_ROUTE_REQUEST_USAGE_EXPORT} = {}; export function GET() { return new Response() }`,
        "/app/api/demo/route.js",
      ),
    ).toThrow("reserved internal name");
  });
});
