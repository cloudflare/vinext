import { Nav } from "./nav";
import { VtBoundary } from "./vt-boundary";

export default function ViewTransitionTypesSource() {
  return (
    <VtBoundary name="source">
      <h1 data-testid="vt-source">source</h1>
      <Nav to="/view-transition-types/target" />
    </VtBoundary>
  );
}
