import type { ComponentType } from "react";

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- ImportMeta augmentation requires interface merging.
  interface ImportMeta {
    glob<T>(pattern: string, options: { eager: true }): Record<string, T>;
  }
}

export type DocPage = {
  slug: string;
  title: string;
  description: string;
  section: string;
  sectionOrder: number;
  order: number;
  navTitle: string;
  keywords: string[];
  external?: string;
  content: ComponentType;
};

type DocModule = {
  default: ComponentType;
  metadata: Record<string, unknown>;
};

const modules = import.meta.glob<DocModule>("../../../../docs/**/*.mdx", { eager: true });

function required<T extends "string" | "number" | "array">(
  metadata: Record<string, unknown>,
  key: string,
  type: T,
  file: string,
): T extends "string" ? string : T extends "number" ? number : string[] {
  const value = metadata[key];
  const valid =
    type === "array"
      ? Array.isArray(value) && value.every((item) => typeof item === "string")
      : typeof value === type;
  if (!valid) throw new Error(`${file} metadata requires ${key} to be a ${type}`);
  return value as never;
}

export const docs = Object.entries(modules)
  .map(([file, module]): DocPage => {
    const metadata = module.metadata;
    if (!metadata) throw new Error(`${file} did not export metadata`);
    return {
      slug: required(metadata, "slug", "string", file),
      title: required(metadata, "title", "string", file),
      description: required(metadata, "description", "string", file),
      section: required(metadata, "section", "string", file),
      sectionOrder: required(metadata, "sectionOrder", "number", file),
      order: required(metadata, "order", "number", file),
      navTitle: required(metadata, "navTitle", "string", file),
      keywords: required(metadata, "keywords", "array", file),
      external: typeof metadata.external === "string" ? metadata.external : undefined,
      content: module.default,
    };
  })
  .sort((a, b) => a.sectionOrder - b.sectionOrder || a.order - b.order);

export const docPages = Object.fromEntries(
  docs.filter((page) => !page.external).map((page) => [page.slug, page]),
);

export const docsNavigation = Array.from(
  Map.groupBy(docs, (page) => page.section),
  ([title, pages]) => ({
    title,
    items: pages.map((page) => ({
      title: page.navTitle,
      href: page.external ?? (page.slug ? `/docs/${page.slug}` : "/docs"),
    })),
  }),
);
