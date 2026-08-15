import World1 from "fake-worker-context-lib/esm-package1/entry";
import World2 from "fake-worker-context-lib/esm-package2/entry";
import World3 from "fake-worker-context-lib/invalid-esm-package/entry";
import { WorkerEsmHydrationMarker } from "../components/worker-esm-hydration-marker";

const worlds = "World+World+World";

export default function Page() {
  return (
    <>
      <p>
        Hello {World1}+{World2}+{World3}+{worlds}
      </p>
      <WorkerEsmHydrationMarker pathname="/static" />
    </>
  );
}
