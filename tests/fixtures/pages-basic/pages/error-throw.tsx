// Page that throws an error during render — used to test enablePrerenderSourceMaps
export default function ErrorThrowPage() {
  throw new Error("Intentional render error for prerender sourcemap test");
}
