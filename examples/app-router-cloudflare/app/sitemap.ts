import type { MetadataRoute } from "next";
import { sitemapOrigin } from "./sitemap-data";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: sitemapOrigin }];
}
