import type { MetadataRoute } from "next";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/protected-robots-entry" } };
}
