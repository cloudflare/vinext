import type { MetadataRoute } from "next";
import { docs } from "./docs/_source";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://vinext.dev",
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: "https://vinext.dev/compatibility",
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: "https://vinext.dev/benchmarks",
      changeFrequency: "daily",
      priority: 0.8,
    },
    ...docs
      .filter((page) => !page.external)
      .map((page) => ({
        url: `https://vinext.dev/docs${page.slug ? `/${page.slug}` : ""}`,
        changeFrequency: "weekly" as const,
        priority: page.slug ? 0.7 : 0.9,
      })),
  ];
}
