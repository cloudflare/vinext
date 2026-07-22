/**
 * Mirrors Next.js's `app/handler/route.js` test fixture used by
 * `test/e2e/app-dir/actions/app-action.test.ts` ("should support setting
 * cookies in route handlers with the correct overrides").
 *
 * The route exercises four sources of Set-Cookie attributes:
 *   - `cookies().set(name, value)` (no options) → gets default `Path=/`
 *   - `cookies().set(name, value, { secure: true })` → keeps Path=/ + Secure
 *   - `cookies().set({ ..., httpOnly, path: '/handler' })` → object form
 *   - returned `new Response(..., { headers: [['Set-Cookie', 'bar=bar2'], ...] })`
 *     which overrides the mutable cookie for `bar` and adds a brand-new `baz`.
 *
 * Each entry must end up as its own Set-Cookie line carrying its full
 * attribute set. https://github.com/cloudflare/vinext/issues/1484
 */
import { cookies } from "next/headers";

export async function GET(): Promise<Response> {
  const localCookies = await cookies();
  localCookies.set("foo", "foo1");
  localCookies.set("bar", "bar1");

  // Key, value, options
  localCookies.set("test1", "value1", { secure: true });

  // One object — different Path than the default.
  localCookies.set({
    name: "test2",
    value: "value2",
    httpOnly: true,
    path: "/handler",
  });

  // Cookies here will be merged with the ones above — `bar` overrides the
  // mutable value, `baz` is a brand-new cookie only set on the response.
  return new Response("Hello, world!", {
    headers: [
      ["Content-Type", "text/custom"],
      ["Set-Cookie", "bar=bar2"],
      ["Set-Cookie", "baz=baz2"],
    ],
  });
}
