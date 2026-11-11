/**
 * Dev-only next/image aspect-ratio distortion diagnostic.
 *
 * Ported from Next.js: packages/next/src/client/image-component.tsx
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/image-component.tsx
 * (vercel/next.js#101349)
 */

const ASPECT_RATIO_DOCS = "https://nextjs.org/docs/app/api-reference/components/image#style";

const warned = new Set<string>();

function warnOnce(message: string): void {
  if (process.env.NODE_ENV === "production") return;
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

function originalImageSrc(src: string): string {
  return new URL(src, "http://n").searchParams.get("url") || src;
}

/**
 * Compare the rendered box with the image's intrinsic proportions. The width
 * and height props alone cannot tell a cropped or rounded image from a
 * distorted one.
 *
 * Warn only when computed `object-fit` is `fill`, since every other value
 * crops or letterboxes instead of distorting. Rendered dimensions are rounded
 * to whole pixels and natural dimensions are truncated after density
 * correction, so allow for that much error in each dimension.
 */
export function getImageAspectRatioWarning(img: HTMLImageElement): string | undefined {
  if (typeof window === "undefined") return;
  if (img.getAttribute("data-nimg") === "fill") return;

  const { width, height, naturalWidth, naturalHeight } = img;
  if (width <= 0 || height <= 0 || naturalWidth <= 0 || naturalHeight <= 0) return;
  if (window.getComputedStyle(img).objectFit !== "fill") return;

  const renderedRatio = width / height;
  const intrinsicRatio = naturalWidth / naturalHeight;
  const tolerance = 0.5 / width + 0.5 / height + 1 / naturalWidth + 1 / naturalHeight;
  if (Math.abs(renderedRatio / intrinsicRatio - 1) <= tolerance) return;

  const origSrc = originalImageSrc(img.src);
  return `Image with src "${origSrc}" is rendered with a different aspect ratio than its intrinsic dimensions. Adjust the width and height props, or use CSS 'width: "auto"' or 'height: "auto"' to preserve the aspect ratio. Read more: ${ASPECT_RATIO_DOCS}`;
}

export function warnIfImageAspectRatioDistorted(img: HTMLImageElement): void {
  if (process.env.NODE_ENV === "production") return;
  const message = getImageAspectRatioWarning(img);
  if (message) warnOnce(message);
}
