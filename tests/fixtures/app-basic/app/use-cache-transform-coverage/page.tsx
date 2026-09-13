import { destructured } from "./destructured";
import { fromServerBoundary } from "./server-boundary";
import { customKind } from "./custom-kind";

export default async function UseCacheTransformCoveragePage() {
  const values = await Promise.all([destructured(), fromServerBoundary(), customKind()]);

  return <output data-testid="use-cache-transform-coverage">{values.join("|")}</output>;
}
