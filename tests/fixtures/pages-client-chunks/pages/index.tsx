import { BRAND } from "../lib/brand";
import { sharedLabel } from "../lib/shared-label";

export default function Home() {
  return (
    <h1>
      {BRAND} {sharedLabel("home")}
    </h1>
  );
}
