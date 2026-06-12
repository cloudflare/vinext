import { destructured } from "./destructured";
import { fromStar } from "./star";
import { objectMethods, StaticMethods } from "./methods";
import { fromServerBoundary } from "./server-boundary";
import { customKind } from "./custom-kind";
import { ServerBoundaryClientCaller } from "./server-boundary-client";

export default async function UseCacheTransformCoveragePage() {
  const values = await Promise.all([
    destructured(),
    fromStar(),
    objectMethods.getValue(),
    StaticMethods.getValue(),
    fromServerBoundary(),
    customKind(),
  ]);

  return (
    <>
      <output data-testid="use-cache-transform-coverage">{values.join("|")}</output>
      <ServerBoundaryClientCaller />
    </>
  );
}
