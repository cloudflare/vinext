# Pages Router Static Assets cache with i18n

The companion to [`static-assets-pages`](../static-assets-pages). It packages
locale-prefixed prerender output with `trailingSlash: true` and a custom
`_error` page:

- `/fr/...` and default-locale paths are served from their own build snapshots.
- `/en/fr/` is the English page named `fr`, not the French home page.
- The `_error` 404 snapshot is never reused for 500 responses.
- Configured i18n domains render at runtime rather than reusing a locale-only
  snapshot.

```sh
vp build
vp run preview
```
