import { Nav } from "../nav";
import { VtBoundary } from "../vt-boundary";

export default function ViewTransitionTypesTarget() {
  return (
    <VtBoundary name="target">
      <h1 data-testid="vt-target">target</h1>
      <Nav to="/view-transition-types" />
    </VtBoundary>
  );
}
