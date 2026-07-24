import type { NextPageContext } from "next";

export const readCookie = (name: string): string | undefined => {
  if (typeof document === "undefined") {
    return undefined;
  }
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`));
  return match?.split("=")[1];
};

const parseCookieHeader = (header: string | undefined): Record<string, string> =>
  Object.fromEntries(
    (header ?? "")
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf("=");
        return [pair.slice(0, idx), pair.slice(idx + 1)];
      }),
  );

/**
 * The native app loads this site inside an embedded shell and sets a cookie
 * so the server can suppress masthead/baseboard chrome. Works
 * isomorphically: request cookies on the server, document.cookie during
 * client-side navigations.
 */
export const insideAppShell = (ctx: NextPageContext | undefined): boolean => {
  if (ctx?.req) {
    return parseCookieHeader(ctx.req.headers.cookie)["atlas-shell"] === "1";
  }
  return readCookie("atlas-shell") === "1";
};
