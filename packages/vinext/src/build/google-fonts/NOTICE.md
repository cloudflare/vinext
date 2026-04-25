# Google Fonts metadata

`font-data.json` is vendored from the Next.js project, file
`packages/font/src/google/font-data.json`:
https://github.com/vercel/next.js/blob/canary/packages/font/src/google/font-data.json

It enumerates every Google Fonts family and, for each, the available weights,
styles, variable axes (with `min`, `max`, `defaultValue`), and subsets. The
file is regenerated upstream from the Google Fonts API; this copy is updated
manually when we sync with a newer Next.js canary.

## Why bundled here

Without this metadata vinext cannot match Next.js's
`next/font/google` behavior when a caller omits `weight`:

- For variable fonts the URL must encode the font's real `wght` axis range
  (e.g. `Sen:wght@400..800`), not a hardcoded `100..900`.
- For static fonts a missing `weight` must be a build-time error, not a
  silent default to "weight 400".
- Variable axes (`opsz`, `slnt`, `wdth`, `GRAD`, etc.) need their min/max to
  emit a valid URL.

This file is consumed only at build time and during dev; it is not shipped to
the Cloudflare Workers production bundle (the production runtime uses the
self-hosted CSS injected by the build plugin).

## License

Next.js is MIT licensed (Copyright (c) 2024 Vercel, Inc.). Both Next.js and
vinext are MIT, so the vendored file is redistributed under the same terms.
