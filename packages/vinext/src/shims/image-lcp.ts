// Development-only diagnostics for next/image. Key metadata by element so
// duplicate URLs cannot change the painted image's loading or placeholder state.
const images = new WeakMap<Element, { src: string; placeholder: string | undefined }>();
// Keep candidates that paint before a Suspense boundary hydrates, without
// retaining DOM elements after they are removed.
const pending = new WeakSet<Element>();
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
  if (pending.delete(image)) warnForImageLcp(image);
  if (observer) return;
  observer = new window.PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const element = (entry as PerformanceEntry & { element?: Element | null }).element;
      if (!element) continue;
      if (images.has(element)) {
        warnForImageLcp(element);
      } else {
        pending.add(element);
      }
    }
  });
  try {
    observer.observe({ type: "largest-contentful-paint", buffered: true });
  } catch (error) {
    // An unsupported performance entry type must not break image rendering.
    console.error(error);
  }
}

function warnForImageLcp(element: Element): void {
  const metadata = images.get(element);
  if (
    !metadata ||
    element.getAttribute("loading") !== "lazy" ||
    (metadata.placeholder !== undefined && metadata.placeholder !== "empty") ||
    metadata.src.startsWith("data:") ||
    metadata.src.startsWith("blob:") ||
    warned.has(metadata.src)
  )
    return;
  warned.add(metadata.src);
  console.warn(
    `Image with src "${metadata.src}" was detected as the Largest Contentful Paint (LCP). Please add the \`loading="eager"\` property if this image is above the fold.` +
      `\nRead more: https://nextjs.org/docs/app/api-reference/components/image#loading`,
  );
}
