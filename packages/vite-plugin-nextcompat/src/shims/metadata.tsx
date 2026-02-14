/**
 * Metadata support for App Router.
 *
 * Handles `export const metadata` and `export async function generateMetadata()`.
 * Resolves metadata from layouts and pages (pages override layouts).
 */
import React from "react";

export interface Metadata {
  title?: string | { default?: string; template?: string; absolute?: string };
  description?: string;
  keywords?: string | string[];
  authors?: Array<{ name?: string; url?: string }> | { name?: string; url?: string };
  creator?: string;
  publisher?: string;
  robots?: string | { index?: boolean; follow?: boolean; [key: string]: unknown };
  openGraph?: {
    title?: string;
    description?: string;
    url?: string;
    siteName?: string;
    images?: Array<{ url: string; width?: number; height?: number; alt?: string }>;
    locale?: string;
    type?: string;
  };
  twitter?: {
    card?: string;
    title?: string;
    description?: string;
    images?: string[];
    creator?: string;
  };
  icons?: {
    icon?: string | Array<{ url: string; sizes?: string; type?: string }>;
    apple?: string | Array<{ url: string; sizes?: string }>;
  };
  alternates?: {
    canonical?: string;
    languages?: Record<string, string>;
  };
  other?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Resolve a title from metadata, applying template if available.
 */
function resolveTitle(
  metadata: Metadata,
  parentTitle?: string | { default?: string; template?: string },
): string | undefined {
  const title = metadata.title;
  if (!title) return undefined;

  if (typeof title === "string") {
    // Apply parent template if available
    if (
      parentTitle &&
      typeof parentTitle === "object" &&
      parentTitle.template
    ) {
      return parentTitle.template.replace("%s", title);
    }
    return title;
  }

  if (title.absolute) return title.absolute;
  if (title.default) return title.default;
  return undefined;
}

/**
 * Merge metadata from multiple sources (layouts + page).
 * Later entries override earlier ones, except for title templating.
 */
export function mergeMetadata(metadataList: Metadata[]): Metadata {
  const merged: Metadata = {};
  let lastTitleTemplate: string | { default?: string; template?: string } | undefined;

  for (const meta of metadataList) {
    // Title needs special handling for templates
    if (meta.title) {
      if (typeof meta.title === "object" && meta.title.template) {
        lastTitleTemplate = meta.title;
      }
    }
    Object.assign(merged, meta);
  }

  // Re-resolve title with template from parent
  if (merged.title && lastTitleTemplate) {
    const resolvedTitle = resolveTitle(
      { title: merged.title },
      lastTitleTemplate,
    );
    if (resolvedTitle) {
      merged.title = resolvedTitle;
    }
  }

  return merged;
}

/**
 * Resolve metadata from a module. Handles both static `metadata` export
 * and async `generateMetadata()` function.
 */
export async function resolveModuleMetadata(
  mod: Record<string, unknown>,
  params: Record<string, string | string[]>,
  searchParams?: Record<string, string>,
): Promise<Metadata | null> {
  if (typeof mod.generateMetadata === "function") {
    return await mod.generateMetadata({ params, searchParams: searchParams ?? {} });
  }
  if (mod.metadata && typeof mod.metadata === "object") {
    return mod.metadata as Metadata;
  }
  return null;
}

/**
 * React component that renders metadata as HTML head elements.
 * Used by the RSC entry to inject into the <head>.
 */
export function MetadataHead({ metadata }: { metadata: Metadata }) {
  const elements: React.ReactElement[] = [];
  let key = 0;

  // Title
  const title =
    typeof metadata.title === "string"
      ? metadata.title
      : typeof metadata.title === "object"
        ? metadata.title.absolute || metadata.title.default
        : undefined;
  if (title) {
    elements.push(<title key={key++}>{title}</title>);
  }

  // Description
  if (metadata.description) {
    elements.push(
      <meta key={key++} name="description" content={metadata.description} />,
    );
  }

  // Keywords
  if (metadata.keywords) {
    const kw = Array.isArray(metadata.keywords)
      ? metadata.keywords.join(", ")
      : metadata.keywords;
    elements.push(<meta key={key++} name="keywords" content={kw} />);
  }

  // Robots
  if (metadata.robots) {
    const robots =
      typeof metadata.robots === "string"
        ? metadata.robots
        : Object.entries(metadata.robots)
            .map(([k, v]) => (v === true ? k : v === false ? `no${k}` : `${k}:${v}`))
            .join(", ");
    elements.push(<meta key={key++} name="robots" content={robots} />);
  }

  // Open Graph
  if (metadata.openGraph) {
    const og = metadata.openGraph;
    if (og.title)
      elements.push(
        <meta key={key++} property="og:title" content={og.title} />,
      );
    if (og.description)
      elements.push(
        <meta
          key={key++}
          property="og:description"
          content={og.description}
        />,
      );
    if (og.url)
      elements.push(
        <meta key={key++} property="og:url" content={og.url} />,
      );
    if (og.siteName)
      elements.push(
        <meta key={key++} property="og:site_name" content={og.siteName} />,
      );
    if (og.type)
      elements.push(
        <meta key={key++} property="og:type" content={og.type} />,
      );
    if (og.locale)
      elements.push(
        <meta key={key++} property="og:locale" content={og.locale} />,
      );
    if (og.images) {
      for (const img of og.images) {
        elements.push(
          <meta key={key++} property="og:image" content={img.url} />,
        );
        if (img.width)
          elements.push(
            <meta
              key={key++}
              property="og:image:width"
              content={String(img.width)}
            />,
          );
        if (img.height)
          elements.push(
            <meta
              key={key++}
              property="og:image:height"
              content={String(img.height)}
            />,
          );
        if (img.alt)
          elements.push(
            <meta key={key++} property="og:image:alt" content={img.alt} />,
          );
      }
    }
  }

  // Twitter
  if (metadata.twitter) {
    const tw = metadata.twitter;
    if (tw.card)
      elements.push(
        <meta key={key++} name="twitter:card" content={tw.card} />,
      );
    if (tw.title)
      elements.push(
        <meta key={key++} name="twitter:title" content={tw.title} />,
      );
    if (tw.description)
      elements.push(
        <meta
          key={key++}
          name="twitter:description"
          content={tw.description}
        />,
      );
    if (tw.creator)
      elements.push(
        <meta key={key++} name="twitter:creator" content={tw.creator} />,
      );
    if (tw.images) {
      for (const img of tw.images) {
        elements.push(
          <meta key={key++} name="twitter:image" content={img} />,
        );
      }
    }
  }

  // Canonical URL
  if (metadata.alternates?.canonical) {
    elements.push(
      <link key={key++} rel="canonical" href={metadata.alternates.canonical} />,
    );
  }

  // Other custom meta tags
  if (metadata.other) {
    for (const [name, content] of Object.entries(metadata.other)) {
      elements.push(<meta key={key++} name={name} content={content} />);
    }
  }

  return <>{elements}</>;
}
