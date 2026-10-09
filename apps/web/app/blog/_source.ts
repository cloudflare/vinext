/**
 * Blog posts are Markdown files in `content/blog/`. The file name is the URL slug
 * (`content/blog/vinext-1-0.md` → `/blog/vinext-1-0`), and each file starts with
 * YAML frontmatter:
 *
 *   title: "Vinext 1.0: …"        # page title, social card and feed title
 *   description: "…"              # meta description; aim for under 160 characters
 *   date: "2026-09-28"            # publish date
 *   updated: "2026-10-01"         # optional, last meaningful edit
 *   authors:                      # names, or { name, url }
 *     - name: Jane Doe
 *       url: https://github.com/jane
 *   tags: [release, caching]      # optional, meta keywords and feed categories
 *   draft: true                   # optional, only listed by the dev server
 *
 * The social card for each post is rendered from this frontmatter by
 * `[slug]/opengraph-image.tsx`.
 */
import type { ComponentType } from "react";

type BlogAuthor = {
  name: string;
  url?: string;
};

export type BlogPost = {
  slug: string;
  title: string;
  description: string;
  /** ISO calendar date (`YYYY-MM-DD`) the post was published. */
  date: string;
  /** ISO calendar date of the last meaningful edit, when it differs from `date`. */
  updated?: string;
  authors: BlogAuthor[];
  tags: string[];
  draft: boolean;
  readingMinutes: number;
  content: ComponentType;
};

type PostModule = {
  default: ComponentType;
  frontmatter?: Record<string, unknown>;
  readingMinutes: number;
};

const modules = import.meta.glob<PostModule>("../../content/blog/*.md", { eager: true });

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FRONTMATTER_KEYS = new Set([
  "title",
  "description",
  "date",
  "updated",
  "authors",
  "tags",
  "draft",
]);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(file: string, message: string): never {
  throw new Error(`${file} frontmatter ${message}`);
}

function string(frontmatter: Record<string, unknown>, key: string, file: string): string {
  const value = frontmatter[key];
  if (typeof value !== "string" || !value.trim()) fail(file, `requires ${key} to be a string`);
  return value;
}

function optionalString(
  frontmatter: Record<string, unknown>,
  key: string,
  file: string,
): string | undefined {
  return frontmatter[key] === undefined ? undefined : string(frontmatter, key, file);
}

function date(frontmatter: Record<string, unknown>, key: string, file: string): string | undefined {
  const value = optionalString(frontmatter, key, file);
  // Round-trip through Date so impossible dates such as 2026-02-30 are rejected too.
  if (
    value !== undefined &&
    (!DATE_PATTERN.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
  ) {
    fail(file, `requires ${key} to be a real YYYY-MM-DD date`);
  }
  return value;
}

function authors(frontmatter: Record<string, unknown>, file: string): BlogAuthor[] {
  const value = frontmatter.authors;
  if (!Array.isArray(value) || value.length === 0) fail(file, "requires at least one author");
  return value.map((author) => {
    if (typeof author === "string") return { name: author };
    if (
      typeof author === "object" &&
      author !== null &&
      typeof author.name === "string" &&
      (author.url === undefined || typeof author.url === "string")
    ) {
      return { name: author.name, url: author.url };
    }
    return fail(file, "requires each author to be a name or { name, url }");
  });
}

function tags(frontmatter: Record<string, unknown>, file: string): string[] {
  const value = frontmatter.tags ?? [];
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) {
    fail(file, "requires tags to be a list of strings");
  }
  return value;
}

const allPosts = Object.entries(modules)
  .map(([file, module]): BlogPost => {
    const frontmatter = module.frontmatter;
    if (!frontmatter) throw new Error(`${file} is missing YAML frontmatter`);
    const slug = file.slice(file.lastIndexOf("/") + 1, -".md".length);
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(`${file} must be named with lowercase words separated by hyphens`);
    }
    // Reject unknown keys so a typo such as `darft: true` can't publish a draft.
    const unknown = Object.keys(frontmatter).filter((key) => !FRONTMATTER_KEYS.has(key));
    if (unknown.length > 0) fail(file, `has unsupported keys: ${unknown.join(", ")}`);
    if (frontmatter.draft !== undefined && typeof frontmatter.draft !== "boolean") {
      fail(file, "requires draft to be a boolean");
    }
    return {
      slug,
      title: string(frontmatter, "title", file),
      description: string(frontmatter, "description", file),
      date: date(frontmatter, "date", file) ?? fail(file, "requires date"),
      updated: date(frontmatter, "updated", file),
      authors: authors(frontmatter, file),
      tags: tags(frontmatter, file),
      draft: frontmatter.draft === true,
      readingMinutes: module.readingMinutes,
      content: module.default,
    };
  })
  .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));

/** Published posts, newest first. Drafts are only listed while developing locally. */
export const posts = allPosts.filter(
  (post) => !post.draft || process.env.NODE_ENV === "development",
);

/** Most recent publish or edit date across published posts, for the feed and sitemap. */
export const blogLastModified = posts
  .filter((post) => !post.draft)
  .map((post) => post.updated ?? post.date)
  .reduce<string | undefined>(
    (latest, value) => (latest && latest > value ? latest : value),
    undefined,
  );

export const postsBySlug = new Map(posts.map((post) => [post.slug, post]));

export const SITE_URL = "https://vinext.dev";

export function postPath(post: Pick<BlogPost, "slug">): string {
  return `/blog/${post.slug}`;
}

/** Format an ISO calendar date without letting the server's time zone shift the day. */
export function formatPostDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}
