import type { MetadataRoute } from "next";

// Rendered on every request: a cached hit would be rebuilt from the ISR entry
// as an unmarked response, which the request trace rewraps like a stream.
export const dynamic = "force-dynamic";

// A metadata route: vinext serializes its body up front and marks the response
// fully buffered, so the response the request trace sees is the one the route
// built, not a wrapper around a streamed body.
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://example.com/request-retention" }];
}
