import type { MetadataRoute } from "next";

export async function generateSitemaps() {
  return [{ id: 0 }, { id: 1 }, { id: "featured" }];
}

export default async function sitemap({
  id,
}: {
  id: Promise<string | undefined>;
}): Promise<MetadataRoute.Sitemap> {
  const sitemapId = await id;
  return [
    {
      url: `https://example.com/products/batch-${sitemapId}/item-1`,
      lastModified: new Date("2025-03-01"),
    },
    {
      url: `https://example.com/products/batch-${sitemapId}/item-2`,
      lastModified: new Date("2025-03-01"),
    },
  ];
}
