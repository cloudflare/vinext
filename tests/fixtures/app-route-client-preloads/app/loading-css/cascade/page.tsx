import { First } from "./first";
import { Second } from "./second";

export const dynamic = "force-dynamic";

// Under loading.js, both stylesheets link in the shell's <head>, in import
// order, though the route's not-found boundary reaches Second first.
export default async function Page() {
  await new Promise((resolve) => setTimeout(resolve, 300));
  return (
    <main>
      <First />
      <Second />
    </main>
  );
}
