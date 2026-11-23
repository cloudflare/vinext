// The project root's package.json declares `"type": "commonjs"`, so the
// Cloudflare plugin's Worker entry is written as index.mjs.
export default function HomePage() {
  return <h1 id="cf-app-cjs-package-scope">CF CJS Package Scope App</h1>;
}
