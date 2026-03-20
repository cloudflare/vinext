/**
 * next/app shim
 *
 * Provides the App component, AppProps, AppContext, and AppInitialProps for _app.tsx.
 *
 * Ported from Next.js: packages/next/src/pages/_app.tsx
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/pages/_app.tsx
 */
import React, { type ComponentType } from "react";

// AppTree is the full app tree type — used in AppContext but rarely needed directly.
export type AppTree = ComponentType<AppInitialProps & { [name: string]: unknown }>;

export interface AppInitialProps<PageProps = unknown> {
  pageProps: PageProps;
}

export interface AppContext {
  Component: ComponentType<unknown>;
  AppTree: AppTree;
  ctx: {
    req?: unknown;
    res?: unknown;
    pathname: string;
    query: Record<string, string | string[]>;
    asPath: string;
    err?: Error & { statusCode?: number };
    locale?: string;
    locales?: readonly string[];
    defaultLocale?: string;
  };
  router: {
    pathname: string;
    query: Record<string, string | string[]>;
    asPath: string;
    locale?: string;
    locales?: readonly string[];
    defaultLocale?: string;
    [key: string]: unknown;
  };
}

export interface AppProps<P = Record<string, unknown>> {
  Component: ComponentType<P>;
  pageProps: P;
  router: AppContext["router"];
}

type ComponentWithGIP = ComponentType<unknown> & {
  getInitialProps?: (ctx: unknown) => Promise<unknown>;
};

/**
 * Default App component — mirrors Next.js's base App class.
 * Custom _app.tsx files typically extend or replace this.
 *
 * The static `getInitialProps` calls `Component.getInitialProps(ctx)` if it
 * exists, returning `{ pageProps }`. This matches Next.js's `loadGetInitialProps`
 * behavior for the default App.
 */
export default class App<P = unknown> extends React.Component<AppProps<P>> {
  static async getInitialProps({ Component, ctx }: AppContext): Promise<AppInitialProps> {
    let pageProps: unknown = {};
    const comp = Component as ComponentWithGIP;
    if (typeof comp.getInitialProps === "function") {
      pageProps = (await comp.getInitialProps(ctx)) ?? {};
    }
    return { pageProps };
  }

  render() {
    const { Component, pageProps } = this.props;
    return React.createElement(
      Component as ComponentType<Record<string, unknown>>,
      pageProps as Record<string, unknown>,
    );
  }
}
