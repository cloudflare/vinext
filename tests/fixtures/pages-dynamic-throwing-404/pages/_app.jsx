// As in `next build`, a custom `_app.getInitialProps` keeps `/404` out of the
// prerender, so its throw doesn't fail the build.
export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}

App.getInitialProps = async () => ({ pageProps: {} });
