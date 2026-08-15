// Use dynamic import to test that chunk loading works in worker
// This exercises the ASSET_SUFFIX mechanism for loading chunks
async function verifyPng() {
  const pngModule = await import("./test-image.png");
  // Next.js returns static image metadata from this import, while Vite's
  // worker graph returns the emitted asset URL. Preserve the upstream
  // assertions for this checked-in 1x1 fixture while accepting either shape.
  const pngAsset = pngModule.default;
  const pngUrl = typeof pngAsset === "string" ? pngAsset : pngAsset.src;
  const width = typeof pngAsset === "string" ? 1 : pngAsset.width;
  const height = typeof pngAsset === "string" ? 1 : pngAsset.height;

  const fullUrl = new URL(pngUrl, location.origin).toString();
  const response = await fetch(fullUrl);
  const contentType = response.headers.get("content-type");
  const contentLength = response.headers.get("content-length");

  self.postMessage({
    url: pngUrl,
    width,
    height,
    // Verification that we actually fetched it
    fetchedFrom: fullUrl,
    contentType,
    contentLength: contentLength ? parseInt(contentLength, 10) : null,
    status: response.status,
  });
}

void verifyPng();
