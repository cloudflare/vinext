import defaultTranspiled from "geist/entry";
import optimized from "optimized-esm-package/entry";
import explicit from "explicit-esm-package/entry";

export default function Page() {
  return (
    <p>
      {defaultTranspiled}+{optimized}+{explicit}
    </p>
  );
}
