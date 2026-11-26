// Modules whose first line is a hashbang (#!), in each module format.
import js from "../cases/js.js";
import cjs from "../cases/cjs.cjs";
import mjs from "../cases/mjs.mjs";
import { RequireClient } from "./require-client.js";

export default function Page() {
  return (
    <main>
      <p data-testid="js">JS: {js}</p>
      <p data-testid="mjs">MJS: {mjs}</p>
      <p data-testid="cjs">CJS: {cjs}</p>
      <RequireClient />
    </main>
  );
}
