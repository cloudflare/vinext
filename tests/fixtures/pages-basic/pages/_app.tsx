import type { AppProps, AppContext } from "next/app";

function MyApp({ Component, pageProps, appProps }: AppProps & { appProps: { appProp: string } }) {
  return (
    <div id="app-wrapper" data-testid="app-wrapper" data-app-prop={appProps.appProp}>
      <nav data-testid="global-nav">
        <span>My App</span>
      </nav>
      <Component {...pageProps} />
    </div>
  );
}

MyApp.getInitialProps = (ctx: AppContext) => ({ appProps: { appProp: ctx.router.query.appProp } });

export default MyApp;
