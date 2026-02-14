/**
 * Metadata support for App Router.
 *
 * Handles `export const metadata` and `export async function generateMetadata()`.
 * Resolves metadata from layouts and pages (pages override layouts).
 */
import React from "react";

// ---------------------------------------------------------------------------
// Viewport types and resolution
// ---------------------------------------------------------------------------

export interface Viewport {
  /** Viewport width (default: "device-width") */
  width?: string | number;
  /** Viewport height */
  height?: string | number;
  /** Initial scale */
  initialScale?: number;
  /** Minimum scale */
  minimumScale?: number;
  /** Maximum scale */
  maximumScale?: number;
  /** Whether user can scale */
  userScalable?: boolean;
  /** Theme color — single color or array of { media, color } */
  themeColor?:
    | string
    | Array<{ media?: string; color: string }>;
  /** Color scheme: 'light' | 'dark' | 'light dark' | 'normal' */
  colorScheme?: string;
}

/**
 * Resolve viewport config from a module. Handles both static `viewport` export
 * and async `generateViewport()` function.
 */
export async function resolveModuleViewport(
  mod: Record<string, unknown>,
  params: Record<string, string | string[]>,
): Promise<Viewport | null> {
  if (typeof mod.generateViewport === "function") {
    return await mod.generateViewport({ params });
  }
  if (mod.viewport && typeof mod.viewport === "object") {
    return mod.viewport as Viewport;
  }
  return null;
}

/**
 * Merge viewport configs from multiple sources (layouts + page).
 * Later entries override earlier ones.
 */
export function mergeViewport(viewportList: Viewport[]): Viewport {
  const merged: Viewport = {};
  for (const vp of viewportList) {
    Object.assign(merged, vp);
  }
  return merged;
}

/**
 * React component that renders viewport meta tags into <head>.
 */
export function ViewportHead({ viewport }: { viewport: Viewport }) {
  const elements: React.ReactElement[] = [];
  let key = 0;

  // Build viewport content string
  const parts: string[] = [];
  if (viewport.width !== undefined) parts.push(`width=${viewport.width}`);
  if (viewport.height !== undefined) parts.push(`height=${viewport.height}`);
  if (viewport.initialScale !== undefined) parts.push(`initial-scale=${viewport.initialScale}`);
  if (viewport.minimumScale !== undefined) parts.push(`minimum-scale=${viewport.minimumScale}`);
  if (viewport.maximumScale !== undefined) parts.push(`maximum-scale=${viewport.maximumScale}`);
  if (viewport.userScalable !== undefined) parts.push(`user-scalable=${viewport.userScalable ? "yes" : "no"}`);

  if (parts.length > 0) {
    elements.push(
      <meta key={key++} name="viewport" content={parts.join(", ")} />,
    );
  }

  // Theme color
  if (viewport.themeColor) {
    if (typeof viewport.themeColor === "string") {
      elements.push(
        <meta key={key++} name="theme-color" content={viewport.themeColor} />,
      );
    } else if (Array.isArray(viewport.themeColor)) {
      for (const entry of viewport.themeColor) {
        elements.push(
          <meta
            key={key++}
            name="theme-color"
            content={entry.color}
            {...(entry.media ? { media: entry.media } : {})}
          />,
        );
      }
    }
  }

  // Color scheme
  if (viewport.colorScheme) {
    elements.push(
      <meta key={key++} name="color-scheme" content={viewport.colorScheme} />,
    );
  }

  return <>{elements}</>;
}

// ---------------------------------------------------------------------------
// Metadata types and resolution
// ---------------------------------------------------------------------------

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
 * Merge metadata from multiple sources (layouts + page).
 *
 * The list is ordered [rootLayout, nestedLayout, ..., page].
 * Title template from layouts applies to the page title but NOT to
 * the segment that defines the template itself. `title.absolute`
 * skips all templates. `title.default` is the fallback when no
 * child provides a title.
 *
 * Shallow merge: later entries override earlier ones (per Next.js docs).
 */
export function mergeMetadata(metadataList: Metadata[]): Metadata {
  if (metadataList.length === 0) return {};

  const merged: Metadata = {};

  // Track the most recent title template from LAYOUTS (not from page).
  // The page is always the last entry in metadataList.
  let parentTemplate: string | undefined;

  for (let i = 0; i < metadataList.length; i++) {
    const meta = metadataList[i];
    const isPage = i === metadataList.length - 1;

    // Collect template from layouts only (page templates are ignored per Next.js spec)
    if (!isPage && meta.title && typeof meta.title === "object" && meta.title.template) {
      parentTemplate = meta.title.template;
    }

    // Shallow merge — later entries override earlier for top-level keys
    for (const key of Object.keys(meta)) {
      if (key === "title") continue; // Handle title separately below
      (merged as Record<string, unknown>)[key] = (meta as Record<string, unknown>)[key];
    }

    // Title resolution
    if (meta.title !== undefined) {
      merged.title = meta.title;
    }
  }

  // Now resolve the final title, applying the parent template if applicable
  const finalTitle = merged.title;
  if (finalTitle) {
    if (typeof finalTitle === "string") {
      // Simple string title — apply parent template
      if (parentTemplate) {
        merged.title = parentTemplate.replace("%s", finalTitle);
      }
    } else if (typeof finalTitle === "object") {
      if (finalTitle.absolute) {
        // Absolute title — skip all templates
        merged.title = finalTitle.absolute;
      } else if (finalTitle.default) {
        // Title object with default — this is used when the segment IS the
        // defining layout (its own default doesn't get template-wrapped)
        merged.title = finalTitle.default;
      } else if (finalTitle.template && !finalTitle.default && !finalTitle.absolute) {
        // Template only with no default — no title to render
        merged.title = undefined;
      }
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
