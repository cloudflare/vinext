// `loader-file=1` marks URLs this loader built, so tests can find it in the
// client bundle too.
export default function imageLoader({ src, width, quality }) {
  return `${src}?loader-file=1&w=${width}&q=${quality || 50}`;
}
