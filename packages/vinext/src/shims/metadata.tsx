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
    const asyncParams = Object.assign(Promise.resolve(params), params);
    return await mod.generateViewport({ params: asyncParams });
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
  generator?: string;
  applicationName?: string;
  referrer?: string;
  keywords?: string | string[];
  authors?: Array<{ name?: string; url?: string }> | { name?: string; url?: string };
  creator?: string;
  publisher?: string;
  robots?: string | { index?: boolean; follow?: boolean; googleBot?: string | { index?: boolean; follow?: boolean; [key: string]: unknown }; [key: string]: unknown };
  openGraph?: {
    title?: string;
    description?: string;
    url?: string;
    siteName?: string;
    images?: string | Array<{ url: string; width?: number; height?: number; alt?: string }>;
    videos?: Array<{ url: string; width?: number; height?: number }>;
    audio?: Array<{ url: string }>;
    locale?: string;
    type?: string;
    publishedTime?: string;
    modifiedTime?: string;
    authors?: string[];
  };
  twitter?: {
    card?: string;
    site?: string;
    siteId?: string;
    title?: string;
    description?: string;
    images?: string | string[] | Array<{ url: string; alt?: string; width?: number; height?: number }>;
    creator?: string;
    creatorId?: string;
  };
  icons?: {
    icon?: string | Array<{ url: string; sizes?: string; type?: string; media?: string }>;
    shortcut?: string | string[];
    apple?: string | Array<{ url: string; sizes?: string; type?: string }>;
    other?: Array<{ rel: string; url: string; sizes?: string; type?: string }>;
  };
  manifest?: string;
  alternates?: {
    canonical?: string;
    languages?: Record<string, string>;
    media?: Record<string, string>;
    types?: Record<string, string>;
  };
  verification?: {
    google?: string;
    yahoo?: string;
    yandex?: string;
    other?: Record<string, string | string[]>;
  };
  metadataBase?: URL | null;
  appleWebApp?: {
    capable?: boolean;
    title?: string;
    statusBarStyle?: string;
    startupImage?: string | Array<{ url: string; media?: string }>;
  };
  formatDetection?: {
    email?: boolean;
    address?: boolean;
    telephone?: boolean;
  };
  category?: string;
  other?: Record<string, string | string[]>;
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
    // Next.js 16 passes params/searchParams as Promises (async pattern).
    // Create thenable objects that work both as Promises and plain objects.
    const asyncParams = Object.assign(Promise.resolve(params), params);
    const sp = searchParams ?? {};
    const asyncSp = Object.assign(Promise.resolve(sp), sp);
    return await mod.generateMetadata({ params: asyncParams, searchParams: asyncSp });
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

  // Resolve metadataBase for URL composition
  const base = metadata.metadataBase;
  function resolveUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    if (!base) return url;
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//")) return url;
    try {
      return new URL(url, base).toString();
    } catch {
      return url;
    }
  }

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

  // Generator
  if (metadata.generator) {
    elements.push(<meta key={key++} name="generator" content={metadata.generator} />);
  }

  // Application name
  if (metadata.applicationName) {
    elements.push(<meta key={key++} name="application-name" content={metadata.applicationName} />);
  }

  // Referrer
  if (metadata.referrer) {
    elements.push(<meta key={key++} name="referrer" content={metadata.referrer} />);
  }

  // Keywords
  if (metadata.keywords) {
    const kw = Array.isArray(metadata.keywords)
      ? metadata.keywords.join(",")
      : metadata.keywords;
    elements.push(<meta key={key++} name="keywords" content={kw} />);
  }

  // Authors
  if (metadata.authors) {
    const authorList = Array.isArray(metadata.authors)
      ? metadata.authors
      : [metadata.authors];
    for (const author of authorList) {
      if (author.name) {
        elements.push(<meta key={key++} name="author" content={author.name} />);
      }
      if (author.url) {
        elements.push(<link key={key++} rel="author" href={author.url} />);
      }
    }
  }

  // Creator
  if (metadata.creator) {
    elements.push(<meta key={key++} name="creator" content={metadata.creator} />);
  }

  // Publisher
  if (metadata.publisher) {
    elements.push(<meta key={key++} name="publisher" content={metadata.publisher} />);
  }

  // Format detection
  if (metadata.formatDetection) {
    const parts: string[] = [];
    if (metadata.formatDetection.telephone === false) parts.push("telephone=no");
    if (metadata.formatDetection.address === false) parts.push("address=no");
    if (metadata.formatDetection.email === false) parts.push("email=no");
    if (parts.length > 0) {
      elements.push(<meta key={key++} name="format-detection" content={parts.join(", ")} />);
    }
  }

  // Category
  if (metadata.category) {
    elements.push(<meta key={key++} name="category" content={metadata.category} />);
  }

  // Robots
  if (metadata.robots) {
    if (typeof metadata.robots === "string") {
      elements.push(<meta key={key++} name="robots" content={metadata.robots} />);
    } else {
      const { googleBot, ...robotsRest } = metadata.robots;
      const robotParts: string[] = [];
      for (const [k, v] of Object.entries(robotsRest)) {
        if (v === true) robotParts.push(k);
        else if (v === false) robotParts.push(`no${k}`);
        else if (typeof v === "string" || typeof v === "number") robotParts.push(`${k}:${v}`);
      }
      if (robotParts.length > 0) {
        elements.push(<meta key={key++} name="robots" content={robotParts.join(", ")} />);
      }
      // googlebot
      if (googleBot) {
        if (typeof googleBot === "string") {
          elements.push(<meta key={key++} name="googlebot" content={googleBot} />);
        } else {
          const gbParts: string[] = [];
          for (const [k, v] of Object.entries(googleBot)) {
            if (v === true) gbParts.push(k);
            else if (v === false) gbParts.push(`no${k}`);
            else if (typeof v === "string" || typeof v === "number") gbParts.push(`${k}:${v}`);
          }
          if (gbParts.length > 0) {
            elements.push(<meta key={key++} name="googlebot" content={gbParts.join(", ")} />);
          }
        }
      }
    }
  }

  // Open Graph
  if (metadata.openGraph) {
    const og = metadata.openGraph;
    if (og.title)
      elements.push(<meta key={key++} property="og:title" content={og.title} />);
    if (og.description)
      elements.push(<meta key={key++} property="og:description" content={og.description} />);
    if (og.url)
      elements.push(<meta key={key++} property="og:url" content={resolveUrl(og.url) ?? og.url} />);
    if (og.siteName)
      elements.push(<meta key={key++} property="og:site_name" content={og.siteName} />);
    if (og.type)
      elements.push(<meta key={key++} property="og:type" content={og.type} />);
    if (og.locale)
      elements.push(<meta key={key++} property="og:locale" content={og.locale} />);
    if (og.publishedTime)
      elements.push(<meta key={key++} property="article:published_time" content={og.publishedTime} />);
    if (og.modifiedTime)
      elements.push(<meta key={key++} property="article:modified_time" content={og.modifiedTime} />);
    if (og.authors) {
      for (const author of og.authors) {
        elements.push(<meta key={key++} property="article:author" content={author} />);
      }
    }
    if (og.images) {
      const imgList = typeof og.images === "string" ? [{ url: og.images }] : og.images;
      for (const img of imgList) {
        const imgUrl = typeof img === "string" ? img : img.url;
        elements.push(<meta key={key++} property="og:image" content={resolveUrl(imgUrl) ?? imgUrl} />);
        if (typeof img !== "string") {
          if (img.width)
            elements.push(<meta key={key++} property="og:image:width" content={String(img.width)} />);
          if (img.height)
            elements.push(<meta key={key++} property="og:image:height" content={String(img.height)} />);
          if (img.alt)
            elements.push(<meta key={key++} property="og:image:alt" content={img.alt} />);
        }
      }
    }
    if (og.videos) {
      for (const video of og.videos) {
        elements.push(<meta key={key++} property="og:video" content={resolveUrl(video.url) ?? video.url} />);
        if (video.width) elements.push(<meta key={key++} property="og:video:width" content={String(video.width)} />);
        if (video.height) elements.push(<meta key={key++} property="og:video:height" content={String(video.height)} />);
      }
    }
    if (og.audio) {
      for (const audio of og.audio) {
        elements.push(<meta key={key++} property="og:audio" content={resolveUrl(audio.url) ?? audio.url} />);
      }
    }
  }

  // Twitter
  if (metadata.twitter) {
    const tw = metadata.twitter;
    if (tw.card)
      elements.push(<meta key={key++} name="twitter:card" content={tw.card} />);
    if (tw.site)
      elements.push(<meta key={key++} name="twitter:site" content={tw.site} />);
    if (tw.siteId)
      elements.push(<meta key={key++} name="twitter:site:id" content={tw.siteId} />);
    if (tw.title)
      elements.push(<meta key={key++} name="twitter:title" content={tw.title} />);
    if (tw.description)
      elements.push(<meta key={key++} name="twitter:description" content={tw.description} />);
    if (tw.creator)
      elements.push(<meta key={key++} name="twitter:creator" content={tw.creator} />);
    if (tw.creatorId)
      elements.push(<meta key={key++} name="twitter:creator:id" content={tw.creatorId} />);
    if (tw.images) {
      const imgList = typeof tw.images === "string"
        ? [tw.images]
        : Array.isArray(tw.images) ? tw.images : [];
      for (const img of imgList) {
        const imgUrl = typeof img === "string" ? img : img.url;
        elements.push(<meta key={key++} name="twitter:image" content={resolveUrl(imgUrl) ?? imgUrl} />);
        if (typeof img !== "string" && img.alt) {
          elements.push(<meta key={key++} name="twitter:image:alt" content={img.alt} />);
        }
      }
    }
  }

  // Icons
  if (metadata.icons) {
    const { icon, shortcut, apple, other } = metadata.icons;
    // Shortcut icon
    if (shortcut) {
      const shortcuts = Array.isArray(shortcut) ? shortcut : [shortcut];
      for (const s of shortcuts) {
        elements.push(<link key={key++} rel="shortcut icon" href={resolveUrl(s) ?? s} />);
      }
    }
    // Icon
    if (icon) {
      const icons = typeof icon === "string" ? [{ url: icon }] : icon;
      for (const i of icons) {
        elements.push(
          <link
            key={key++}
            rel="icon"
            href={resolveUrl(i.url) ?? i.url}
            {...(i.sizes ? { sizes: i.sizes } : {})}
            {...(i.type ? { type: i.type } : {})}
            {...(i.media ? { media: i.media } : {})}
          />,
        );
      }
    }
    // Apple touch icon
    if (apple) {
      const apples = typeof apple === "string" ? [{ url: apple }] : apple;
      for (const a of apples) {
        elements.push(
          <link
            key={key++}
            rel="apple-touch-icon"
            href={resolveUrl(a.url) ?? a.url}
            {...(a.sizes ? { sizes: a.sizes } : {})}
            {...(a.type ? { type: a.type } : {})}
          />,
        );
      }
    }
    // Other custom icon relations
    if (other) {
      for (const o of other) {
        elements.push(
          <link key={key++} rel={o.rel} href={resolveUrl(o.url) ?? o.url} {...(o.sizes ? { sizes: o.sizes } : {})} />,
        );
      }
    }
  }

  // Manifest
  if (metadata.manifest) {
    elements.push(<link key={key++} rel="manifest" href={resolveUrl(metadata.manifest) ?? metadata.manifest} />);
  }

  // Alternates
  if (metadata.alternates) {
    const alt = metadata.alternates;
    if (alt.canonical) {
      elements.push(<link key={key++} rel="canonical" href={resolveUrl(alt.canonical) ?? alt.canonical} />);
    }
    if (alt.languages) {
      for (const [lang, href] of Object.entries(alt.languages)) {
        elements.push(<link key={key++} rel="alternate" hrefLang={lang} href={resolveUrl(href) ?? href} />);
      }
    }
    if (alt.media) {
      for (const [media, href] of Object.entries(alt.media)) {
        elements.push(<link key={key++} rel="alternate" media={media} href={resolveUrl(href) ?? href} />);
      }
    }
    if (alt.types) {
      for (const [type, href] of Object.entries(alt.types)) {
        elements.push(<link key={key++} rel="alternate" type={type} href={resolveUrl(href) ?? href} />);
      }
    }
  }

  // Verification
  if (metadata.verification) {
    const v = metadata.verification;
    if (v.google) elements.push(<meta key={key++} name="google-site-verification" content={v.google} />);
    if (v.yahoo) elements.push(<meta key={key++} name="y_key" content={v.yahoo} />);
    if (v.yandex) elements.push(<meta key={key++} name="yandex-verification" content={v.yandex} />);
    if (v.other) {
      for (const [name, content] of Object.entries(v.other)) {
        const values = Array.isArray(content) ? content : [content];
        for (const val of values) {
          elements.push(<meta key={key++} name={name} content={val} />);
        }
      }
    }
  }

  // Apple Web App
  if (metadata.appleWebApp) {
    const awa = metadata.appleWebApp;
    if (awa.capable !== false) {
      elements.push(<meta key={key++} name="mobile-web-app-capable" content="yes" />);
    }
    if (awa.title) {
      elements.push(<meta key={key++} name="apple-mobile-web-app-title" content={awa.title} />);
    }
    if (awa.statusBarStyle) {
      elements.push(<meta key={key++} name="apple-mobile-web-app-status-bar-style" content={awa.statusBarStyle} />);
    }
    if (awa.startupImage) {
      const imgs = typeof awa.startupImage === "string" ? [{ url: awa.startupImage }] : awa.startupImage;
      for (const img of imgs) {
        elements.push(
          <link
            key={key++}
            rel="apple-touch-startup-image"
            href={resolveUrl(img.url) ?? img.url}
            {...(img.media ? { media: img.media } : {})}
          />,
        );
      }
    }
  }

  // Other custom meta tags
  if (metadata.other) {
    for (const [name, content] of Object.entries(metadata.other)) {
      const values = Array.isArray(content) ? content : [content];
      for (const val of values) {
        elements.push(<meta key={key++} name={name} content={val} />);
      }
    }
  }

  return <>{elements}</>;
}
