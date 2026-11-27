import Link from "next/link";
import { Nav } from "./nav";
import { VtBoundary } from "./vt-boundary";

export default function ViewTransitionTypesSource() {
  return (
    <VtBoundary name="source">
      <h1 data-testid="vt-source">source</h1>
      <Nav to="/view-transition-types/target" />
      <Link
        href="/view-transition-types/slow/2"
        transitionTypes={["nav-shell"]}
        data-testid="typed-slow-link"
      >
        typed slow link
      </Link>
    </VtBoundary>
  );
}
