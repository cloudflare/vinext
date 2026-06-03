import styles from "../styles/css-url-global.module.css";

// Mirrors the Next.js scss/url-global fixture's index page: a single element
// whose stylesheet references two byte-identical svg files via url(). Both
// `dark.*.svg` and `dark2.*.svg` must be emitted and served.
export default function CssUrlAssets() {
  return (
    <div data-testid="css-url-assets" className={styles.redText}>
      This text should be red.
    </div>
  );
}
