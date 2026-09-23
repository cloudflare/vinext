// Mirrors Next.js: test/e2e/app-dir/scss/with-styled-jsx/pages/_app.js
import "../styles/global.css";

export default function App({ Component, pageProps }) {
  return <Component {...pageProps} />;
}
