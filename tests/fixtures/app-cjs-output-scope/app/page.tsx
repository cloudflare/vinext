// The project root is `"type": "module"`, but the build writes its server
// output into `cjs-output/`, a nested `"type": "commonjs"` package.
export default function HomePage() {
  return <h1 id="cjs-output-scope-home">CJS Output Scope</h1>;
}
