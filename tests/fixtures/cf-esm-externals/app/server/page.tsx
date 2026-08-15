import World1 from "fake-worker-context-lib/app-esm-package1/entry";
import World2 from "fake-worker-context-lib/app-esm-package2/entry";
import World3 from "fake-worker-context-lib/app-cjs-esm-package/entry";
import { WorkerEsmHydrationMarker } from "../../components/worker-esm-hydration-marker";

export default function Page() {
  return (
    <>
      <p>
        Hello {World1}+{World2}+{World3}
      </p>
      <WorkerEsmHydrationMarker pathname="/server" />
    </>
  );
}
