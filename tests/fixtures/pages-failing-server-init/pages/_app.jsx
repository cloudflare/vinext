// As in `next build`, an `_app` that fails to load fails the build.
throw new Error("_app failed to load");

export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
