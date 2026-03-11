/**
 * Tests for collectFontPreloads CDN URL acceptance in font-local.ts.
 *
 * The critical bug: collectFontPreloads previously only accepted href.startsWith("/"),
 * which silently dropped <link rel="preload"> for CDN URLs when assetPrefix is a
 * full https:// or protocol-relative // URL. The fix accepts https://, http://, and //.
 */
import { describe, it, expect } from "vitest"
import localFont, { getSSRFontPreloads } from "../packages/vinext/src/shims/font-local.js"

describe("collectFontPreloads — CDN URL acceptance", () => {
  it("collects https:// CDN font URL for preload (not silently dropped)", () => {
    localFont({ src: "https://cdn.example.com/assets/font-cdn-https-unique-1.woff2" })
    const preloads = getSSRFontPreloads()
    expect(preloads).toContainEqual({
      href: "https://cdn.example.com/assets/font-cdn-https-unique-1.woff2",
      type: "font/woff2",
    })
  })

  it("collects standard /assets/ font URL for preload", () => {
    localFont({ src: "/assets/font-standard-unique-2.woff2" })
    const preloads = getSSRFontPreloads()
    expect(preloads).toContainEqual({
      href: "/assets/font-standard-unique-2.woff2",
      type: "font/woff2",
    })
  })

  it("collects protocol-relative // CDN font URL for preload (not silently dropped)", () => {
    localFont({ src: "//cdn.example.com/assets/font-proto-rel-unique-3.woff2" })
    const preloads = getSSRFontPreloads()
    expect(preloads).toContainEqual({
      href: "//cdn.example.com/assets/font-proto-rel-unique-3.woff2",
      type: "font/woff2",
    })
  })

  it("collects http:// CDN font URL for preload", () => {
    localFont({ src: "http://cdn.example.com/assets/font-cdn-http-unique-4.woff2" })
    const preloads = getSSRFontPreloads()
    expect(preloads).toContainEqual({
      href: "http://cdn.example.com/assets/font-cdn-http-unique-4.woff2",
      type: "font/woff2",
    })
  })

  it("does not collect bare relative font paths (no leading slash or scheme)", () => {
    const before = getSSRFontPreloads().length
    localFont({ src: "relative/path/font-unique-5.woff2" })
    const after = getSSRFontPreloads()
    expect(after.length).toBe(before)
  })
})
