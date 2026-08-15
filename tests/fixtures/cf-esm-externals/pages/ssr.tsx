import World1 from "fake-worker-context-lib/esm-package1/entry";
import World2 from "fake-worker-context-lib/esm-package2/entry";
import World3 from "fake-worker-context-lib/invalid-esm-package/entry";
import { WorkerEsmHydrationMarker } from "../components/worker-esm-hydration-marker";

export function getServerSideProps() {
  return { props: { worlds: `${World1}+${World2}+${World3}` } };
}

export default function Page({ worlds }: { worlds: string }) {
  return (
    <>
      <p>
        Hello {World1}+{World2}+{World3}+{worlds}
      </p>
      <WorkerEsmHydrationMarker pathname="/ssr" />
    </>
  );
}
