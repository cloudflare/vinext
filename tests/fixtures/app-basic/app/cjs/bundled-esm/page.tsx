import { src, t } from "./bundled-semver.js";

export default function Page() {
  return (
    <div data-testid="cjs-bundled-esm">
      {t.FULL}:{src.join(",")}
    </div>
  );
}
