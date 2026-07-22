// Test: JSX in plain .js files (not .tsx/.jsx).
// Next.js supports this via Babel/SWC; vinext must enable OXC JSX for .js.
export default function JsxInJsPage() {
  return (
    <div>
      <h1 data-testid="jsx-in-js">Hello JSX in JS</h1>
      <p>This page uses JSX syntax in a plain .js file</p>
    </div>
  );
}
