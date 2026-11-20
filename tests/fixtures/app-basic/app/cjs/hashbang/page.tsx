// Ported from Next.js: test/integration/hashbang/src/pages/index.js
// https://github.com/vercel/next.js/blob/v16.2.6/test/integration/hashbang/src/pages/index.js
import js from "./js.js";
import cjs from "./cjs.cjs";
import mjs from "./mjs.mjs";

export default function Page() {
  return <div data-testid="cjs-hashbang">{`JS: ${js} MJS: ${mjs} CJS: ${cjs}`}</div>;
}
