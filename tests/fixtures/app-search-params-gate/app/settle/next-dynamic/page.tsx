import { RenderId } from "../../fixture-parts";
import { DynamicSearchValue } from "./dynamic-search-value";

// No boundary of its own: only the one next/dynamic renders can catch the
// bail-out, so the route fails without it.
export default function Page() {
  return (
    <main>
      <RenderId />
      <DynamicSearchValue hookReadEvent="next-dynamic-hook-read" />
    </main>
  );
}
