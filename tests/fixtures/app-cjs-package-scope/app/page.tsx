import { redirect } from "next/navigation";
import { exportedAction } from "./actions";

// The project root's package.json declares `"type": "commonjs"`. Inline and
// exported Server Actions must still build and serve as ESM.
export default function HomePage() {
  async function inlineAction() {
    "use server";
    redirect("/?action=inline");
  }

  return (
    <main>
      <h1 id="cjs-package-scope-home">CJS Package Scope</h1>
      <form action={inlineAction}>
        <button type="submit">inline</button>
      </form>
      <form action={exportedAction}>
        <button type="submit">exported</button>
      </form>
    </main>
  );
}
