import { Second } from "../siblings/second";
import { Unrelated } from "./unrelated";

export const dynamic = "force-dynamic";

// Rendering Second here too keeps it out of the home page's route group, so
// the two siblings link separate stylesheets.
export default function Other() {
  return (
    <>
      <Unrelated />
      <Second />
    </>
  );
}
