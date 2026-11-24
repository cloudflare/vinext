Barrel packages for `tests/optimize-imports-node-cjs.test.ts`.

- `node-cjs-icons` is laid out like lucide-react 1.x: `exports["."]` lists
  `module` before a `node` condition that points at a CommonJS build, so the
  ESM barrel wins in key order.
- `node-first-icons` lists `node` (CommonJS) before `import`/`module`, so the
  CommonJS build wins in key order, as it does in Next.js.
