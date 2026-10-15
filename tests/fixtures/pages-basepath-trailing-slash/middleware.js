// The matcher is written without the basePath; Next.js prefixes it, so it
// gates only /docs/private/*.
export function middleware() {
  return new Response("blocked by middleware", { status: 403 });
}

export const config = {
  matcher: ["/private/:path*"],
};
