/** Build identity stamped by the Cloudflare CDN adapter on page responses. */
export const VINEXT_CDN_BUILD_ID_HEADER = "X-Vinext-Build-Id";

/** Opaque identity shared by every server entry emitted by one vinext build. */
export function getVinextCdnBuildIdentity(): string | null {
  return process.env.__VINEXT_RSC_BUILD_IDENTITY || process.env.__VINEXT_BUILD_ID || null;
}
