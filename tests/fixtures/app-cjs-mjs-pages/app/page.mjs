import { redirect } from "next/navigation";
import { exportedAction } from "./actions.mjs";

// The project root's package.json declares `"type": "commonjs"`, and the app's
// own modules are `.mjs`. Inline and exported Server Actions must still work.
export default function HomePage() {
  async function inlineAction() {
    "use server";
    redirect("/?action=inline");
  }

  return (
    <main>
      <h1>CJS Package Scope</h1>
      <form action={inlineAction}>
        <button type="submit">inline</button>
      </form>
      <form action={exportedAction}>
        <button type="submit">exported</button>
      </form>
    </main>
  );
}
