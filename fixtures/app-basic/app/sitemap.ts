export default function sitemap() {
  return [
    {
      url: "https://example.com",
      lastModified: new Date("2025-01-01"),
      changeFrequency: "yearly" as const,
      priority: 1,
    },
    {
      url: "https://example.com/about",
      lastModified: new Date("2025-01-15"),
      changeFrequency: "monthly" as const,
      priority: 0.8,
    },
    {
      url: "https://example.com/blog",
      lastModified: new Date("2025-02-01"),
      changeFrequency: "weekly" as const,
      priority: 0.5,
    },
  ];
}
