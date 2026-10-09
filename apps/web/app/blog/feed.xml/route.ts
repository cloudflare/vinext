import { blogLastModified, postPath, posts, SITE_URL } from "../_source";

export const dynamic = "force-static";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rfc822(date: string): string {
  return new Date(`${date}T00:00:00Z`).toUTCString();
}

export function GET() {
  const published = posts.filter((post) => !post.draft);
  const items = published
    .map((post) => {
      const url = `${SITE_URL}${postPath(post)}`;
      return [
        "    <item>",
        `      <title>${escapeXml(post.title)}</title>`,
        `      <link>${url}</link>`,
        `      <guid isPermaLink="true">${url}</guid>`,
        `      <description>${escapeXml(post.description)}</description>`,
        `      <pubDate>${rfc822(post.date)}</pubDate>`,
        ...post.authors.map((author) => `      <dc:creator>${escapeXml(author.name)}</dc:creator>`),
        ...post.tags.map((tag) => `      <category>${escapeXml(tag)}</category>`),
        "    </item>",
      ].join("\n");
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Vinext blog</title>
    <link>${SITE_URL}/blog</link>
    <description>Release notes, deep dives, and engineering updates from the Vinext team.</description>
    <language>en-us</language>
    <atom:link href="${SITE_URL}/blog/feed.xml" rel="self" type="application/rss+xml" />
${blogLastModified ? `    <lastBuildDate>${rfc822(blogLastModified)}</lastBuildDate>\n` : ""}${items}
  </channel>
</rss>
`;

  return new Response(xml, {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
