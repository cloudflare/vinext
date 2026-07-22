import Link from "next/link";
import { RouterImporter } from "./router-importer";

export default function RouterSideEffectLeakPage() {
  return (
    <main>
      <h1>Router side effect leak source</h1>
      <RouterImporter />
      <Link id="side-effect-destination-link" href="/router-side-effect-leak/destination">
        Destination
      </Link>
    </main>
  );
}
