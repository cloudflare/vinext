// Ported from Next.js: test/e2e/next-image-new/loader-config/dummy-loader.js
// https://github.com/vercel/next.js/blob/canary/test/e2e/next-image-new/loader-config/dummy-loader.js
export default function dummyLoader({
  src,
  width,
  quality,
}: {
  src: string;
  width: number;
  quality?: number;
}): string {
  return `${src}#w:${width},q:${quality || 50}`;
}
