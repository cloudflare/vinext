/**
 * Server-side styled-jsx style collection for Pages Router SSR.
 *
 * Next.js wraps every Pages Router render in styled-jsx's `<StyleRegistry>`
 * and renders the collected `registry.styles()` into the document (through
 * `_document`'s `styles` prop, or `ctx.defaultGetInitialProps()`; see
 * `server/pages-styled-jsx.ts` for where vinext places them). Without a
 * registry, styled-jsx's `JSXStyle` renders nothing on the server, so
 * `<style jsx>` rules would only appear after client hydration.
 *
 * Ported from Next.js: packages/next/src/server/render.tsx
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/render.tsx
 * (search for `jsxStyleRegistry`).
 *
 * This module deliberately does NOT import styled-jsx. The `vinext:styled-jsx`
 * plugin appends a registration import to every server module it compiles, so
 * styled-jsx is only loaded (and Pages renders only gain a registry wrapper)
 * when the app actually uses `<style jsx>` or `styled-jsx/css`. Registration
 * runs at module evaluation, before any render of a page that imports it.
 */
import React, { type ComponentType, type ReactElement, type ReactNode } from "react";

type StyledJsxStyleRegistry = {
  styles(options?: { nonce?: string }): ReactElement<{ id?: string }>[];
  flush(): void;
};

export type StyledJsxRuntime = {
  StyleRegistry: ComponentType<{ registry?: StyledJsxStyleRegistry; children?: ReactNode }>;
  createStyleRegistry: () => StyledJsxStyleRegistry;
};

let registeredRuntime: StyledJsxRuntime | null = null;

/** Called by the `vinext:styled-jsx` registration module with styled-jsx's own exports. */
export function registerStyledJsxRuntime(runtime: StyledJsxRuntime): void {
  registeredRuntime = runtime;
}

export type PagesStyledJsxCollector = {
  /** Wrap a Pages render tree so its `<style jsx>` rules land in this collector. */
  wrap(element: ReactNode): ReactElement;
  /**
   * Return the styles registered since the last flush as
   * `<style id="__jsx-…">` elements and reset the registry, matching Next.js's
   * `registry.styles()` + `flush()`. A rule already returned by an earlier
   * flush of this render (e.g. with the shell, before a Suspense boundary
   * registered it again) is not returned twice.
   */
  flushStyles(nonce?: string): ReactElement[];
};

/**
 * Create a per-render styled-jsx collector, or `null` when no module compiled
 * by the styled-jsx plugin has been loaded in this module graph.
 */
export function createPagesStyledJsxCollector(): PagesStyledJsxCollector | null {
  const runtime = registeredRuntime;
  if (!runtime) return null;
  const { StyleRegistry, createStyleRegistry } = runtime;
  const registry = createStyleRegistry();
  const emittedIds = new Set<string>();
  return {
    wrap(element) {
      return React.createElement(StyleRegistry, { registry }, element);
    },
    flushStyles(nonce) {
      const styles = registry.styles(nonce ? { nonce } : undefined).filter((style) => {
        const id = style.props.id;
        if (id === undefined) return true;
        if (emittedIds.has(id)) return false;
        emittedIds.add(id);
        return true;
      });
      registry.flush();
      return styles;
    },
  };
}
