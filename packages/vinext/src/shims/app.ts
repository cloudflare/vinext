/**
 * next/app shim
 *
 * Provides the AppProps type and default App component for _app.tsx.
 */
import React, { type ComponentType } from "react";

export type AppProps<P = Record<string, unknown>> = {
  Component: ComponentType<P>;
  pageProps: P;
};

type AppContext = {
  Component: ComponentType & {
    getInitialProps?: (ctx: unknown) => unknown | Promise<unknown>;
  };
  ctx: unknown;
};

export default class App<P = Record<string, unknown>> extends React.Component<AppProps<P>> {
  static async getInitialProps({ Component, ctx }: AppContext): Promise<{ pageProps: unknown }> {
    const pageProps =
      typeof Component.getInitialProps === "function" ? await Component.getInitialProps(ctx) : {};
    return { pageProps };
  }

  render(): React.ReactNode {
    const { Component, pageProps } = this.props;
    return React.createElement(
      Component as ComponentType<Record<string, unknown>>,
      pageProps as Record<string, unknown>,
    );
  }
}
