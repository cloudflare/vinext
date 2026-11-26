---
"vinext": patch
---

Load a CommonJS `next.config.js` or `postcss.config.js` in a `"type": "module"` package when its `require()` sits inside a call, array or object, like `console.log(require("webpack"))` or `plugins: [require("tailwindcss")]`.
