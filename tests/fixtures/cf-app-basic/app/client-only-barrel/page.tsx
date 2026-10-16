import { BarrelLabel } from "client-only-barrel";

// Regression: https://github.com/cloudflare/vinext/issues/4007
// `client-only-barrel` is `sideEffects: false`, and its unused `BarrelWidget`
// module imports `client-only`. Tree-shaking drops that module from the RSC
// build, so the build must not fail on the marker.
export default function ClientOnlyBarrelPage() {
  return <p data-testid="client-only-barrel">{BarrelLabel()}</p>;
}
