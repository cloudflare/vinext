import type { MetadataRoute } from "next";
import { cacheLife } from "next/cache";

// Cached metadata routes are prerendered and packaged alongside the pages. The
// packaged copy is read-only, so give it a lifetime longer than the deployment.
export default async function robots(): Promise<MetadataRoute.Robots> {
  "use cache";
  cacheLife("max");
  return { rules: { userAgent: "*", allow: "/" } };
}
