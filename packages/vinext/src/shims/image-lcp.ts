// Development-only diagnostics for next/image. Key metadata by element so
// duplicate URLs cannot change the painted image's loading or placeholder state.
const images = new WeakMap<Element, { src: string; placeholder: string | undefined }>();
const warned = new Set<string>();
let observer: PerformanceObserver | undefined;

export function registerImageLcp(
  image: HTMLImageElement,
  src: string,
  placeholder: string | undefined,
): void {
  if (
    process.env.NODE_ENV === "production" ||
    typeof window === "undefined" ||
    !window.PerformanceObserver
  )
    return;
  images.set(image, { src, placeholder });
  if (observer) return;
  observer = new window.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const element = (entry as PerformanceEntry & { element?: Element | null }).element;
      const metadata = element ? images.get(element) : undefined;
      if (
        !metadata ||
        element?.getAttribute("loading") !== "lazy" ||
        (metadata.placeholder !== undefined && metadata.placeholder !== "empty") ||
        metadata.src.startsWith("data:") ||
        metadata.src.startsWith("blob:") ||
        warned.has(metadata.src)
      )
        continue;
      warned.add(metadata.src);
      console.warn(
        `Image with src "${metadata.src}" was detected as the Largest Contentful Paint (LCP). Please add the \`loading="eager"\` property if this image is above the fold.` +
          `\nRead more: https://nextjs.org/docs/app/api-reference/components/image#loading`,
      );
    }
  });
  try {
    observer.observe({ type: "largest-contentful-paint", buffered: true });
  } catch (error) {
    // An unsupported performance entry type must not break image rendering.
    console.error(error);
  }
}
