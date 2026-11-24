Barrel packages for `tests/optimize-imports-node-cjs.test.ts`.

- `node-cjs-icons` is laid out like lucide-react 1.x: `exports["."]` lists
  `module` before a `node` condition that points at a CommonJS build, so the
  ESM barrel wins in key order. Its top-level `main` is the CommonJS build
  and it has no top-level `module`, so the ESM barrel is reached only through
  `exports["."]`.
- `node-first-icons` lists `node` (CommonJS) before `import`/`module`, so the
  CommonJS build wins in key order, as it does in Next.js. Its top-level
  `module` is the ESM barrel, so the CommonJS build is reached only through
  `exports["."]`.
