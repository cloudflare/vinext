export default function sitemap() {
  return [
    {
      url: "https://example.com",
      lastModified: new Date("2025-01-01"),
      changeFrequency: "yearly" as const,
      priority: 1,
      alternates: {
        languages: {
          fr: "https://example.com/fr",
          "en-US": "https://example.com/en-US",
        },
      },
      images: ["https://example.com/image.jpg"],
      videos: [
        {
          title: "Homepage Video",
          thumbnail_loc: "https://example.com/video-thumb.jpg",
          description: "Homepage teaser",
          content_loc: "https://example.com/video.mp4",
        },
      ],
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
