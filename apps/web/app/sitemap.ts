import type { MetadataRoute } from "next";
import { postPath, posts } from "./blog/_source";
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
    {
      url: "https://vinext.dev/blog",
      lastModified: posts[0] ? (posts[0].updated ?? posts[0].date) : undefined,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...posts
      .filter((post) => !post.draft)
      .map((post) => ({
        url: `https://vinext.dev${postPath(post)}`,
        lastModified: post.updated ?? post.date,
        changeFrequency: "monthly" as const,
        priority: 0.7,
      })),
    ...docs
      .filter((page) => !page.external)
      .map((page) => ({
        url: `https://vinext.dev/docs${page.slug ? `/${page.slug}` : ""}`,
        changeFrequency: "weekly" as const,
        priority: page.slug ? 0.7 : 0.9,
      })),
  ];
}
