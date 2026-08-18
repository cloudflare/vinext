import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://vinext.dev",
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: "https://vinext.dev/compatibility",
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: "https://vinext.dev/benchmarks",
      changeFrequency: "monthly",
      priority: 0.8,
    },
  ];
}
