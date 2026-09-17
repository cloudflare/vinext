export function proxy(request: Request): void {
  if (new URL(request.url).pathname === "/proxy-error") {
    throw new Error("Intentional Sentry App Router proxy error");
  }
}

export const config = { matcher: "/proxy-error" };
